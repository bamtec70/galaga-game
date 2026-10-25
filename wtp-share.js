/* wtp-share.js: "SHARE SCORE" button for the game-over screen.
   Usage: WTPShare.show(score) at game over, WTPShare.hide() when a new game starts.
   Mobile: Web Share API. Desktop / fallback: copies the text to the clipboard. */
(function () {
  "use strict";
  var GAME = (document.currentScript && document.currentScript.getAttribute("data-game")) || document.title;
  var btn = null, last = 0, tmr = 0;
  function fmt(n) { return Math.max(0, Math.floor(+n || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function text(n) { return "I scored " + fmt(n) + " in " + GAME + " at wethepeoplepress.com/games. Can you beat me?"; }
  function isTouch() { return (window.matchMedia && matchMedia("(pointer: coarse)").matches) || navigator.maxTouchPoints > 0; }
  function label(s) { if (btn) btn.textContent = s; }
  function copy(t) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return legacy(t); });
    }
    return Promise.resolve(legacy(t));
  }
  function legacy(t) {
    try {
      var ta = document.createElement("textarea"); ta.value = t; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0"; document.body.appendChild(ta);
      ta.select(); var ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
    } catch (_) { return false; }
  }
  function flash(s) { label(s); clearTimeout(tmr); tmr = setTimeout(function () { label("SHARE SCORE"); }, 2200); }
  function share() {
    var t = text(last);
    window.__wtpLastShare = t;
    if (navigator.share && isTouch()) {
      navigator.share({ text: t }).then(function () { flash("SHARED!"); }, function (e) {
        if (e && e.name === "AbortError") return;
        copy(t).then(function (ok) { flash(ok ? "COPIED!" : "COPY FAILED"); });
      });
      return;
    }
    copy(t).then(function (ok) { flash(ok ? "COPIED! PASTE IT" : "COPY FAILED"); });
  }
  function make() {
    if (btn) return btn;
    var st = document.createElement("style");
    st.textContent = "#wtp-share{position:fixed;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483000;" +
      "font:12px/1 'Press Start 2P',monospace;letter-spacing:1px;color:#ff0;background:#000;border:2px solid #ff0;padding:10px 14px;" +
      "cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;display:none}" +
      "#wtp-share:hover,#wtp-share:focus-visible{background:#ff0;color:#000;outline:none}" +
      "body.touch #wtp-share{bottom:auto;top:max(10px,env(safe-area-inset-top));font-size:11px}";
    document.head.appendChild(st);
    btn = document.createElement("button");
    btn.id = "wtp-share"; btn.type = "button"; btn.textContent = "SHARE SCORE";
    btn.setAttribute("aria-label", "Share your score");
    var stop = function (e) { e.stopPropagation(); };
    ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "keydown", "keyup"].forEach(function (t) { btn.addEventListener(t, stop); });
    btn.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); share(); btn.blur(); });
    document.body.appendChild(btn);
    return btn;
  }
  window.WTPShare = {
    show: function (score) { last = +score || 0; if (last <= 0) return; make(); label("SHARE SCORE"); btn.style.display = "block"; },
    hide: function () { if (btn) btn.style.display = "none"; },
    text: function (n) { return text(n == null ? last : n); },
    share: share
  };
})();
