/* Домик · колонка вместе с ТВ — часть, работающая внутри страницы YouTube на телевизоре.
 *
 * Делает две вещи:
 *   1. перехватывает ответы плеера YouTube и запоминает прямую ссылку на звуковую дорожку;
 *   2. каждые 400 мс сообщает служебной части (127.0.0.1:8099) точное положение видео.
 *
 * Написано на ES5: на части телевизоров Tizen очень старый движок.
 */
(function () {
    'use strict';

    var SERVICE = 'http://127.0.0.1:8099';
    var REPORT_MS = 400;

    var tracks = {};        // videoId -> { url: String, duration: Number }
    var lastSeenId = null;  // последний videoId из ответа плеера

    // ------------------------------------------------------------------ сбор ссылок

    function pickAudio(streamingData) {
        var formats = streamingData.adaptiveFormats || [];
        var best = null;
        for (var i = 0; i < formats.length; i++) {
            var f = formats[i];
            if (!f.url || !f.mimeType) continue;
            if (f.mimeType.indexOf('audio/mp4') !== 0) continue;
            if (f.itag === 140) return f;          // 128 kbps AAC — его колонка играет точно
            if (!best || (f.bitrate || 0) > (best.bitrate || 0)) best = f;
        }
        return best;
    }

    function harvest(json) {
        try {
            if (!json || !json.videoDetails || !json.streamingData) return;
            var id = json.videoDetails.videoId;
            if (!id) return;
            var audio = pickAudio(json.streamingData);
            if (!audio) return;                    // бывает при защищённом содержимом
            tracks[id] = {
                url: audio.url,
                duration: parseFloat(json.videoDetails.lengthSeconds || '0') || 0
            };
            lastSeenId = id;
        } catch (e) { /* молча: страница важнее */ }
    }

    function isPlayerUrl(url) {
        return typeof url === 'string' && url.indexOf('/youtubei/v1/player') !== -1;
    }

    // fetch
    if (window.fetch) {
        var origFetch = window.fetch;
        window.fetch = function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var promise = origFetch.apply(this, arguments);
            if (isPlayerUrl(url)) {
                try {
                    promise.then(function (res) {
                        try {
                            res.clone().json().then(harvest, function () {});
                        } catch (e) {}
                        return res;
                    }, function () {});
                } catch (e) {}
            }
            return promise;
        };
    }

    // XMLHttpRequest
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (isPlayerUrl(url)) {
            this.addEventListener('load', function () {
                try {
                    if (this.responseText) harvest(JSON.parse(this.responseText));
                } catch (e) {}
            });
        }
        return origOpen.apply(this, arguments);
    };

    // ------------------------------------------------------------------ связь со службой

    function post(path, body) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', SERVICE + path, true);
            // text/plain — чтобы браузер не слал предварительный запрос CORS
            xhr.setRequestHeader('Content-Type', 'text/plain');
            xhr.send(JSON.stringify(body));
        } catch (e) {}
    }

    // ------------------------------------------------------------------ что играет

    function currentVideo() {
        var videos = document.getElementsByTagName('video');
        for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (v.readyState > 0 && isFinite(v.duration) && v.duration > 0) return v;
        }
        return videos.length ? videos[0] : null;
    }

    /** Какому videoId соответствует то, что сейчас в плеере: сверяем по длительности. */
    function matchId(video) {
        if (!video || !isFinite(video.duration)) return lastSeenId;
        var best = null, bestDiff = 2.5;
        for (var id in tracks) {
            if (!tracks.hasOwnProperty(id)) continue;
            var d = tracks[id].duration;
            if (!d) continue;
            var diff = Math.abs(d - video.duration);
            if (diff < bestDiff) { bestDiff = diff; best = id; }
        }
        return best || lastSeenId;
    }

    var lastSent = null;

    function report() {
        var video = currentVideo();
        if (!video) {
            if (lastSent !== 'none') { post('/state', { playing: false, reason: 'no-video' }); lastSent = 'none'; }
            return;
        }
        var id = matchId(video);
        var track = id ? tracks[id] : null;
        post('/state', {
            videoId: id,
            url: track ? track.url : null,
            position: video.currentTime,
            duration: isFinite(video.duration) ? video.duration : 0,
            rate: video.playbackRate,
            playing: !video.paused && !video.ended && video.readyState >= 2,
            muted: video.muted,
            at: Date.now()
        });
        lastSent = id;
    }

    setInterval(report, REPORT_MS);

    // Сразу сообщаем о важных переменах, не дожидаясь следующего круга.
    var EVENTS = ['play', 'pause', 'seeked', 'ended', 'loadedmetadata', 'ratechange'];
    document.addEventListener('DOMContentLoaded', hookEvents, false);
    setTimeout(hookEvents, 3000);

    var hooked = false;
    function hookEvents() {
        if (hooked) return;
        var video = currentVideo();
        if (!video) { setTimeout(hookEvents, 1000); return; }
        hooked = true;
        for (var i = 0; i < EVENTS.length; i++) {
            video.addEventListener(EVENTS[i], function () { setTimeout(report, 30); }, false);
        }
    }

    post('/hello', { ua: navigator.userAgent, at: Date.now() });
})();
