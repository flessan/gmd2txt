/* Single release identifier shared by the shell and service worker. */
(function (scope) {
  scope.GMDPLAYER_META = Object.freeze({ name: "GMDPlayer", version: "1.0.0", cacheRevision: "4" });
})(typeof self !== "undefined" ? self : globalThis);
