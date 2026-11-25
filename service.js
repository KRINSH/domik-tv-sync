/* Домик · колонка вместе с ТВ — служебная часть, работает на телевизоре.
 *
 * Принимает от страницы YouTube точное положение видео и держит колонку Google Nest
 * на том же месте той же дорожки. Колонка берёт звук прямо с серверов YouTube.
 *
 * Написано на ES5 и только на встроенных возможностях Node (http, tls):
 * на телевизорах Tizen движок бывает очень старый, а сторонних библиотек там нет.
 */
'use strict';

var http = require('http');
var net = require('net');
var os = require('os');
var tls = require('tls');

var CONFIG = {
    nestIp: '',         // пусто — найдём колонку в своей сети сами
    port: 8099,
    offset: 0.0,        // насколько колонка должна опережать ТВ по дорожке (с), калибруется один раз
    lead: 2.2,          // на сколько вперёд ставим колонку перед стартом (с)
    playLatency: 0.25,  // задержка команды «играй» до реального звука (с), подстраивается сама
    syncOk: 0.030,      // такое расхождение считаем совпадением (с)
    resyncOver: 0.070,  // больше этого — переставляем колонку (с)
    enabled: true,
    verbose: false
};

var LOG = [];
function log() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    var line = new Date().toISOString().substr(11, 12) + ' ' + parts.join(' ');
    LOG.push(line);
    if (LOG.length > 400) LOG.shift();
    try { console.log('[domik] ' + line); } catch (e) {}
}

function bytes(arr) {
    return Buffer.from ? Buffer.from(arr) : new Buffer(arr);
}
function utf8(str) {
    return Buffer.from ? Buffer.from(str, 'utf8') : new Buffer(str, 'utf8');
}

// ---------------------------------------------------------------- протокол Google Cast

var NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
var NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
var NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
var NS_MEDIA = 'urn:x-cast:com.google.cast.media';
var SOURCE_ID = 'sender-domik';
var DEFAULT_RECEIVER = 'CC1AD845';

function varint(value) {
    var out = [];
    while (value >= 0x80) {
        out.push((value & 0x7f) | 0x80);
        value = Math.floor(value / 128);
    }
    out.push(value);
    return bytes(out);
}

function stringField(field, str) {
    var data = utf8(str);
    return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}

function encodeMessage(destination, namespace, payload) {
    var body = Buffer.concat([
        bytes([0x08, 0x00]),                 // protocol_version = CASTV2_1_0
        stringField(2, SOURCE_ID),
        stringField(3, destination),
        stringField(4, namespace),
        bytes([0x28, 0x00]),                 // payload_type = STRING
        stringField(6, payload)
    ]);
    var header = bytes([0, 0, 0, 0]);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

function decodeMessage(buf) {
    var i = 0, out = { source: '', destination: '', namespace: '', payload: '' };
    function readVarint() {
        var result = 0, shift = 1;
        while (i < buf.length) {
            var b = buf[i]; i++;
            result += (b & 0x7f) * shift;
            if ((b & 0x80) === 0) return result;
            shift *= 128;
            if (shift > 1e15) return null;
        }
        return null;
    }
    while (i < buf.length) {
        var key = readVarint();
        if (key === null) break;
        var wire = key & 7, field = Math.floor(key / 8);
        if (wire === 0) { if (readVarint() === null) break; }
        else if (wire === 2) {
            var len = readVarint();
            if (len === null || i + len > buf.length) break;
            var str = buf.toString('utf8', i, i + len);
            i += len;
            if (field === 2) out.source = str;
            else if (field === 3) out.destination = str;
            else if (field === 4) out.namespace = str;
            else if (field === 6) out.payload = str;
        } else if (wire === 1) i += 8;
        else if (wire === 5) i += 4;
        else break;
    }
    return out;
}

// ---------------------------------------------------------------- поиск колонки

/* Колонки Google Cast слушают порт 8009. Ищем их в своей подсети: адрес телевизора
   известен из его сетевых настроек, перебираем соседей и берём первого, кто ответил. */
var finder = { busy: false, lastTry: 0, found: null };

function localSubnet() {
    var ifaces = os.networkInterfaces();
    for (var name in ifaces) {
        if (!ifaces.hasOwnProperty(name)) continue;
        var list = ifaces[name] || [];
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            var family = a.family === 'IPv4' || a.family === 4;
            if (!family || a.internal) continue;
            var dot = a.address.lastIndexOf('.');
            if (dot > 0) return a.address.substring(0, dot + 1);
        }
    }
    return null;
}

function probeCast(ip, done) {
    var socket = new net.Socket();
    var finished = false;
    function end(ok) {
        if (finished) return;
        finished = true;
        try { socket.destroy(); } catch (e) {}
        done(ok);
    }
    socket.setTimeout(1200);
    socket.on('connect', function () { end(true); });
    socket.on('timeout', function () { end(false); });
    socket.on('error', function () { end(false); });
    try { socket.connect(8009, ip); } catch (e) { end(false); }
}

function findSpeaker() {
    if (finder.busy || Date.now() - finder.lastTry < 20000) return;
    var prefix = localSubnet();
    if (!prefix) return;
    finder.busy = true;
    finder.lastTry = Date.now();
    log('ищу колонку в сети', prefix + '0/24');
    var next = 1, open = 0, done = false;
    function finish(ip) {
        if (done) return;
        done = true;
        finder.busy = false;
        if (ip) { CONFIG.nestIp = ip; log('колонка найдена:', ip); nestConnect(); }
        else log('колонка в сети не найдена');
    }
    function step() {
        while (open < 24 && next < 255 && !done) {
            var ip = prefix + next;
            next += 1;
            open += 1;
            (function (address) {
                probeCast(address, function (ok) {
                    open -= 1;
                    if (ok) finish(address);
                    else if (next >= 255 && open === 0) finish(null);
                    else step();
                });
            })(ip);
        }
    }
    step();
}

// ---------------------------------------------------------------- связь с колонкой

var nest = {
    socket: null,
    ready: false,           // соединение установлено, приложение запущено
    transportId: null,
    sessionId: null,
    mediaSessionId: null,
    contentId: null,
    playerState: null,
    position: 0,
    positionAt: 0,
    requestId: 1,
    buffer: bytes([]),
    connecting: false,
    lastError: null
};

function nestSend(destination, namespace, obj) {
    if (!nest.socket) return false;
    try {
        nest.socket.write(encodeMessage(destination, namespace, JSON.stringify(obj)));
        return true;
    } catch (e) {
        log('ошибка отправки:', e.message);
        return false;
    }
}

function nextRequestId() {
    nest.requestId += 1;
    return nest.requestId;
}

function nestConnect() {
    if (nest.connecting || nest.socket) return;
    if (!CONFIG.nestIp) { findSpeaker(); return; }
    nest.connecting = true;
    log('подключаюсь к колонке', CONFIG.nestIp);
    var socket;
    try {
        socket = tls.connect({ host: CONFIG.nestIp, port: 8009, rejectUnauthorized: false });
    } catch (e) {
        nest.connecting = false;
        nest.lastError = e.message;
        return;
    }
    socket.setTimeout(0);

    socket.on('secureConnect', function () {
        nest.socket = socket;
        nest.connecting = false;
        nest.buffer = bytes([]);
        nest.lastError = null;
        log('колонка на связи');
        nestSend('receiver-0', NS_CONNECTION, { type: 'CONNECT' });
        nestSend('receiver-0', NS_RECEIVER, { type: 'GET_STATUS', requestId: nextRequestId() });
    });

    socket.on('data', function (chunk) {
        nest.buffer = Buffer.concat([nest.buffer, chunk]);
        while (nest.buffer.length >= 4) {
            var length = nest.buffer.readUInt32BE(0);
            if (nest.buffer.length < 4 + length) break;
            var frame = nest.buffer.slice(4, 4 + length);
            nest.buffer = nest.buffer.slice(4 + length);
            try { handleNest(decodeMessage(frame)); } catch (e) { log('разбор:', e.message); }
        }
    });

    function drop(why) {
        if (nest.socket !== socket && nest.connecting === false && !nest.socket) return;
        log('колонка отключилась:', why);
        nest.socket = null;
        nest.connecting = false;
        nest.ready = false;
        nest.transportId = null;
        nest.mediaSessionId = null;
        nest.contentId = null;
        nest.playerState = null;
        try { socket.destroy(); } catch (e) {}
    }

    socket.on('error', function (e) { nest.lastError = e.message; drop(e.message); });
    socket.on('close', function () { drop('соединение закрыто'); });
    socket.on('end', function () { drop('конец соединения'); });
}

function handleNest(msg) {
    if (msg.namespace === NS_HEARTBEAT) {
        if (msg.payload.indexOf('PING') !== -1) nestSend(msg.source, NS_HEARTBEAT, { type: 'PONG' });
        return;
    }
    if (CONFIG.verbose) log('<<', msg.namespace.split('.').pop(), msg.payload.substr(0, 400));
    var data;
    try { data = JSON.parse(msg.payload); } catch (e) { return; }

    if (msg.namespace === NS_RECEIVER && data.type === 'RECEIVER_STATUS') {
        var apps = (data.status && data.status.applications) || [];
        var found = null;
        for (var i = 0; i < apps.length; i++) {
            if (apps[i].appId === DEFAULT_RECEIVER) found = apps[i];
        }
        if (found) {
            if (nest.transportId !== found.transportId) {
                nest.transportId = found.transportId;
                nest.sessionId = found.sessionId;
                nest.mediaSessionId = null;
                nestSend(nest.transportId, NS_CONNECTION, { type: 'CONNECT' });
                log('приложение колонки готово');
            }
            nest.ready = true;
        } else {
            nest.ready = false;
            nest.transportId = null;
            nest.mediaSessionId = null;
            if (apps.length === 0) nest.busy = false;
            else nest.busy = true;      // колонка занята чем-то другим
        }
        return;
    }

    if (msg.namespace === NS_MEDIA && data.type === 'MEDIA_STATUS') {
        var list = data.status || [];
        if (list.length === 0) { nest.playerState = 'IDLE'; return; }
        var st = list[0];
        nest.mediaSessionId = st.mediaSessionId;
        nest.playerState = st.playerState;
        if (typeof st.currentTime === 'number') {
            nest.position = st.currentTime;
            nest.positionAt = Date.now();
        }
        if (st.media && st.media.contentId) nest.contentId = st.media.contentId;
        return;
    }
}

function nestLaunch() {
    nestSend('receiver-0', NS_RECEIVER, { type: 'LAUNCH', appId: DEFAULT_RECEIVER, requestId: nextRequestId() });
}

function nestLoad(url, position) {
    if (!nest.transportId) return false;
    nest.mediaSessionId = null;
    nest.contentId = url;
    return nestSend(nest.transportId, NS_MEDIA, {
        type: 'LOAD',
        requestId: nextRequestId(),
        sessionId: nest.sessionId,
        autoplay: false,
        currentTime: Math.max(0, position),
        media: { contentId: url, contentType: 'audio/mp4', streamType: 'BUFFERED' }
    });
}

function nestMedia(type, extra) {
    if (!nest.transportId || !nest.mediaSessionId) return false;
    var msg = { type: type, requestId: nextRequestId(), mediaSessionId: nest.mediaSessionId };
    for (var k in extra) if (extra.hasOwnProperty(k)) msg[k] = extra[k];
    return nestSend(nest.transportId, NS_MEDIA, msg);
}

function nestStatus() {
    if (nest.transportId && nest.mediaSessionId) nestMedia('GET_STATUS', {});
    if (nest.socket) nestSend('receiver-0', NS_RECEIVER, { type: 'GET_STATUS', requestId: nextRequestId() });
}

function nestPosition() {
    if (nest.playerState !== 'PLAYING') return nest.position;
    return nest.position + (Date.now() - nest.positionAt) / 1000;
}

// ---------------------------------------------------------------- что играет телевизор

var tv = { videoId: null, url: null, position: 0, at: 0, playing: false, rate: 1, duration: 0, seen: 0 };

function tvPosition() {
    if (!tv.playing) return tv.position;
    return tv.position + (Date.now() - tv.at) / 1000 * (tv.rate || 1);
}

function tvFresh() {
    return Date.now() - tv.seen < 3000;
}

// ---------------------------------------------------------------- согласование

var sync = {
    phase: 'idle',       // idle | loading | seeking | arming | playing
    videoId: null,
    target: 0,           // куда просили встать колонку
    timer: null,         // точный таймер нажатия «играй»
    lastCheck: 0,
    armedAt: 0,
    lastDrift: null,
    tries: 0
};

function setPhase(phase) {
    if (sync.phase !== phase) {
        sync.phase = phase;
        log('состояние:', phase);
    }
}

function clearTimer() {
    if (sync.timer) { clearTimeout(sync.timer); sync.timer = null; }
}

function stopNest() {
    clearTimer();
    if (nest.playerState === 'PLAYING' || nest.playerState === 'BUFFERING') nestMedia('PAUSE', {});
    setPhase('idle');
}

/** Ставим колонку на паузу впереди телевизора; запустим её точно в нужный миг. */
function arm() {
    clearTimer();
    var target = tvPosition() + CONFIG.offset + CONFIG.lead;
    if (tv.duration && target > tv.duration - 2) { setPhase('idle'); return; }
    sync.target = target;
    sync.armedAt = Date.now();
    if (nest.contentId !== tv.url || !nest.mediaSessionId) {
        if (!nestLoad(tv.url, target)) { setPhase('idle'); return; }
        setPhase('loading');
    } else {
        nestMedia('SEEK', { currentTime: target, resumeState: 'PLAYBACK_PAUSE' });
        setPhase('seeking');
    }
}

/** Колонка стоит на паузе на известной позиции — считаем, когда нажимать «играй». */
function schedulePlay() {
    if (nest.playerState !== 'PAUSED') return false;
    if (Date.now() - nest.positionAt > 1500) { nestStatus(); return false; }  // позиция устарела
    var wait = (nest.position - CONFIG.offset - tvPosition()) / (tv.rate || 1) - CONFIG.playLatency;
    if (wait < -0.5) { arm(); return true; }            // не успеваем — встаём заново
    if (wait < 0) wait = 0;                             // чуть опоздали — жмём сразу
    if (wait > CONFIG.lead + 2) { arm(); return true; } // слишком далеко — тоже заново
    clearTimer();
    sync.timer = setTimeout(function () {
        sync.timer = null;
        nestMedia('PLAY', {});
        setPhase('playing');
        sync.lastCheck = Date.now() + 2000;             // дать колонке раскрутиться
    }, Math.round(wait * 1000));
    return true;
}

function tick() {
    if (!CONFIG.enabled) return;
    if (!nest.socket) { nestConnect(); return; }

    var now = Date.now();

    if (!tvFresh() || !tv.playing || !tv.url) {
        if (sync.phase !== 'idle') stopNest();
        return;
    }

    if (nest.busy && !nest.ready) {
        if (sync.phase !== 'idle') { clearTimer(); setPhase('idle'); }
        return;
    }

    if (!nest.ready) { nestLaunch(); return; }

    if (tv.videoId !== sync.videoId) {
        sync.videoId = tv.videoId;
        sync.tries = 0;
        sync.lastDrift = null;
        arm();
        return;
    }

    if (sync.phase === 'idle') { arm(); return; }

    if (sync.phase === 'loading' || sync.phase === 'seeking') {
        if (now - sync.armedAt > 12000) { setPhase('idle'); return; }
        if (!nest.mediaSessionId) return;
        if (nest.playerState === 'PAUSED') {
            if (sync.phase === 'seeking' && Math.abs(nest.position - sync.target) > 1.0) { nestStatus(); return; }
            setPhase('arming');
        } else if (nest.playerState === 'IDLE' && now - sync.armedAt > 2500) {
            setPhase('idle');
        } else if (now - sync.lastCheck > 300) {
            sync.lastCheck = now;
            nestStatus();
        }
        return;
    }

    if (sync.phase === 'arming') {
        if (sync.timer) return;                       // момент уже назначен
        if (now - sync.armedAt > 12000) { arm(); return; }
        if (!schedulePlay() && now - sync.lastCheck > 300) { sync.lastCheck = now; nestStatus(); }
        return;
    }

    if (sync.phase === 'playing') {
        if (now < sync.lastCheck) return;
        sync.lastCheck = now + 2000;
        nestStatus();
        if (nest.playerState !== 'PLAYING') {
            if (nest.playerState === 'IDLE' || nest.playerState === 'PAUSED') arm();
            return;
        }
        var drift = nestPosition() - (tvPosition() + CONFIG.offset);
        sync.lastDrift = drift;
        if (Math.abs(drift) < CONFIG.syncOk) { sync.tries = 0; return; }
        if (Math.abs(drift) > CONFIG.resyncOver) {
            sync.tries += 1;
            // Колонка ушла вперёд на drift → в следующий раз нажимать «играй» позже.
            // Большие выбросы бывают от устаревших данных — по ним не учимся.
            if (Math.abs(drift) < 0.6) {
                CONFIG.playLatency = Math.min(2.0, Math.max(-1.0, CONFIG.playLatency - drift * 0.7));
            }
            log('расхождение', Math.round(drift * 1000) + ' мс, переставляю (задержка пуска ' + CONFIG.playLatency.toFixed(3) + ')');
            nestMedia('PAUSE', {});
            arm();
        }
    }
}

setInterval(tick, 200);
setInterval(function () { if (nest.socket) nestSend('receiver-0', NS_HEARTBEAT, { type: 'PING' }); }, 5000);

// ---------------------------------------------------------------- приём данных с телевизора

function readBody(req, done) {
    var data = '';
    req.on('data', function (c) { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', function () { done(data); });
}

var server = http.createServer(function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    var path = req.url.split('?')[0];

    if (path === '/state' && req.method === 'POST') {
        readBody(req, function (body) {
            try {
                var s = JSON.parse(body);
                tv.seen = Date.now();
                if (s.playing) {
                    tv.videoId = s.videoId || tv.videoId;
                    if (s.url) tv.url = s.url;
                    tv.position = s.position;
                    tv.at = s.at || Date.now();
                    tv.rate = s.rate || 1;
                    tv.duration = s.duration || 0;
                    tv.playing = !s.muted;
                } else {
                    tv.playing = false;
                    if (s.videoId && s.videoId !== tv.videoId) { tv.videoId = s.videoId; tv.url = s.url || null; }
                }
            } catch (e) {}
            res.writeHead(204); res.end();
        });
        return;
    }

    if (path === '/hello') { readBody(req, function () { log('страница YouTube на связи'); res.writeHead(204); res.end(); }); return; }

    if (path === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            config: CONFIG,
            tv: { videoId: tv.videoId, playing: tv.playing, position: tvPosition(), fresh: tvFresh(), hasUrl: !!tv.url, duration: tv.duration },
            nest: { connected: !!nest.socket, ready: nest.ready, busy: !!nest.busy, state: nest.playerState, position: nestPosition(), error: nest.lastError },
            sync: { phase: sync.phase, videoId: sync.videoId, driftMs: sync.lastDrift === null ? null : Math.round(sync.lastDrift * 1000) }
        }, null, 1));
        return;
    }

    if (path === '/log') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(LOG.join('\n'));
        return;
    }

    if (path === '/config' && req.method === 'POST') {
        readBody(req, function (body) {
            try {
                var patch = JSON.parse(body);
                for (var k in patch) if (CONFIG.hasOwnProperty(k)) CONFIG[k] = patch[k];
                log('настройки изменены:', body);
            } catch (e) {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(CONFIG));
        });
        return;
    }

    if (path === '/resync') { stopNest(); sync.videoId = null; res.writeHead(204); res.end(); return; }

    res.writeHead(404); res.end('domik');
});

// 0.0.0.0 — чтобы с Mac можно было посмотреть состояние и один раз настроить задержку.
server.listen(CONFIG.port, '0.0.0.0', function () {
    log('служба запущена на порту', CONFIG.port);
});

nestConnect();
