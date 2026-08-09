/* ============================================================
   Pixelbench — assets/js/app.js
   Shared behaviour for every page, plus the toolkit that the
   individual tool pages build on.

   Nothing here makes a network request. Files are read from
   disk with the File API and stay in memory on this device.

   Exposed as window.Pixelbench:
     ready(fn)                    run after DOM is parsed
     formatBytes(n)               1048576 -> "1.0 MB"
     typeLabel(file)              -> "JPEG"
     extFor(mime)                 -> "jpg"
     baseName(name)               "a.b.png" -> "a.b"
     renameExt(name, ext)         -> "a.b.webp"
     isImage(file)                -> boolean
     decodeImage(file)            -> {source, width, height, release()}
     canEncode(mime)              -> Promise<boolean>
     canvasToBlob(cv, mime, q)    -> Promise<Blob>
     downloadBlob(blob, name)
     toast(message)
     copyText(text)
     clamp(n, min, max)
     debounce(fn, ms)
     createDropzone(el, opts)     -> {destroy()}
     putHandoff(files)            stash files for another page
     takeHandoff(opts)            -> Promise<File[]>
   ============================================================ */

(function () {
  'use strict';

  var PB = {};

  /* ----------------------------------------------------------
     Constants
  ---------------------------------------------------------- */

  var MIME_LABELS = {
    'image/jpeg': 'JPEG',
    'image/jpg': 'JPEG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/avif': 'AVIF',
    'image/gif': 'GIF',
    'image/bmp': 'BMP',
    'image/x-icon': 'ICO',
    'image/vnd.microsoft.icon': 'ICO',
    'image/svg+xml': 'SVG',
    'image/heic': 'HEIC',
    'image/heif': 'HEIF',
    'image/tiff': 'TIFF'
  };

  var MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/svg+xml': 'svg',
    'image/heic': 'heic',
    'image/tiff': 'tiff',
    'application/pdf': 'pdf'
  };

  // Some systems report an empty MIME type for these, so check the
  // extension as well before rejecting a file.
  var IMAGE_EXTENSIONS = [
    'jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'gif', 'bmp',
    'ico', 'svg', 'heic', 'heif', 'tif', 'tiff'
  ];

  var HANDOFF_DB = 'pixelbench';
  var HANDOFF_STORE = 'handoff';
  var HANDOFF_KEY = 'files';
  var HANDOFF_TTL = 10 * 60 * 1000; // stale after ten minutes

  /* ----------------------------------------------------------
     Small utilities
  ---------------------------------------------------------- */

  PB.ready = function (fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  };

  PB.clamp = function (n, min, max) {
    return Math.min(max, Math.max(min, n));
  };

  PB.debounce = function (fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 150);
    };
  };

  PB.formatBytes = function (bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(bytes < 10485760 ? 2 : 1) + ' MB';
  };

  PB.extension = function (name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  };

  PB.baseName = function (name) {
    return (name || 'image').replace(/\.[^.]+$/, '');
  };

  PB.extFor = function (mime) {
    return MIME_EXT[mime] || 'img';
  };

  PB.renameExt = function (name, ext) {
    return PB.baseName(name) + '.' + ext;
  };

  PB.typeLabel = function (file) {
    if (!file) return '—';
    var label = MIME_LABELS[file.type];
    if (label) return label;
    var ext = PB.extension(file.name);
    return ext ? ext.toUpperCase() : 'Unknown';
  };

  PB.isImage = function (file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('image/') === 0) return true;
    return IMAGE_EXTENSIONS.indexOf(PB.extension(file.name)) !== -1;
  };

  PB.copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(ta);
      }
    });
  };

  /* ----------------------------------------------------------
     Toast
  ---------------------------------------------------------- */

  var toastEl, toastTimer;

  PB.toast = function (message, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    // Force a reflow so re-triggering restarts the transition.
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, ms || 2400);
  };

  /* ----------------------------------------------------------
     Image decoding

     Returns a drawable source plus its true pixel dimensions.
     createImageBitmap is faster and handles EXIF orientation,
     but it refuses SVG in some browsers, so fall back to an
     <img> element there.
  ---------------------------------------------------------- */

  PB.decodeImage = function (file) {
    var useBitmap = typeof createImageBitmap === 'function' &&
                    file.type !== 'image/svg+xml';

    if (useBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .then(function (bitmap) {
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            release: function () { if (bitmap.close) bitmap.close(); }
          };
        })
        .catch(function () { return decodeWithImg(file); });
    }
    return decodeWithImg(file);
  };

  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        resolve({
          source: img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          release: function () { URL.revokeObjectURL(url); }
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('This browser can\'t open ' + PB.typeLabel(file) + ' files.'));
      };
      img.src = url;
    });
  }

  /* ----------------------------------------------------------
     Encoder support detection

     Browsers quietly fall back to PNG when asked for a format
     they can't write, so ask for a 1×1 and check what came back.
  ---------------------------------------------------------- */

  var encodeCache = {};

  PB.canEncode = function (mime) {
    if (encodeCache[mime]) return encodeCache[mime];
    encodeCache[mime] = new Promise(function (resolve) {
      try {
        var cv = document.createElement('canvas');
        cv.width = cv.height = 1;
        cv.toBlob(function (blob) {
          resolve(!!blob && blob.type === mime);
        }, mime, 0.85);
      } catch (err) {
        resolve(false);
      }
    });
    return encodeCache[mime];
  };

  PB.canvasToBlob = function (canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Encoding to ' + (MIME_LABELS[mime] || mime) + ' failed.'));
      }, mime, quality);
    });
  };

  PB.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'image';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
  };

  /* ----------------------------------------------------------
     Handoff store

     Carries dropped files from the homepage into a tool page.
     IndexedDB holds File objects natively, so nothing is
     re-encoded or copied through a string.
  ---------------------------------------------------------- */

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('No IndexedDB')); return; }
      var req = indexedDB.open(HANDOFF_DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(HANDOFF_STORE)) {
          db.createObjectStore(HANDOFF_STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(HANDOFF_STORE, mode);
        var result = fn(tx.objectStore(HANDOFF_STORE));
        tx.oncomplete = function () { db.close(); resolve(result && result.result); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  PB.putHandoff = function (files) {
    var list = Array.prototype.slice.call(files);
    return withStore('readwrite', function (store) {
      return store.put({ files: list, at: Date.now() }, HANDOFF_KEY);
    }).catch(function () { /* handoff is a convenience, not a requirement */ });
  };

  PB.takeHandoff = function (opts) {
    var keep = opts && opts.keep;
    return withStore('readonly', function (store) {
      return store.get(HANDOFF_KEY);
    }).then(function (record) {
      if (!record || !record.files || !record.files.length) return [];
      if (Date.now() - record.at > HANDOFF_TTL) {
        PB.clearHandoff();
        return [];
      }
      if (!keep) PB.clearHandoff();
      return record.files;
    }).catch(function () { return []; });
  };

  PB.clearHandoff = function () {
    return withStore('readwrite', function (store) {
      return store.delete(HANDOFF_KEY);
    }).catch(function () {});
  };

  /* ----------------------------------------------------------
     Theme

     Three states so "auto" stays a real choice rather than a
     one-way trip into whichever mode you tapped last.
  ---------------------------------------------------------- */

  var THEMES = ['auto', 'light', 'dark'];

  function currentTheme() {
    var stored = null;
    try { stored = localStorage.getItem('pb-theme'); } catch (err) {}
    return THEMES.indexOf(stored) !== -1 ? stored : 'auto';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('pb-theme', theme); } catch (err) {}
  }

  function initTheme() {
    applyTheme(currentTheme());
    var btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
      applyTheme(next);
      PB.toast(next === 'auto' ? 'Theme follows your system' :
               next === 'dark' ? 'Dark theme on' : 'Light theme on');
    });
  }

  /* ----------------------------------------------------------
     Mobile navigation
  ---------------------------------------------------------- */

  function initNav() {
    var head = document.querySelector('.site-head');
    var btn = document.querySelector('[data-nav-toggle]');
    if (!head || !btn) return;

    function setOpen(open) {
      head.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Hide menu' : 'Show menu');
    }

    btn.addEventListener('click', function () {
      setOpen(!head.classList.contains('is-open'));
    });

    head.addEventListener('click', function (e) {
      if (e.target.closest('.nav a')) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && head.classList.contains('is-open')) {
        setOpen(false);
        btn.focus();
      }
    });

    document.addEventListener('click', function (e) {
      if (head.classList.contains('is-open') && !head.contains(e.target)) setOpen(false);
    });
  }

  /* ----------------------------------------------------------
     Dropzone factory

     Used by the homepage hero and by every tool page.
       createDropzone(el, {
         input: HTMLInputElement,   // optional file input
         multiple: false,
         paste: true,               // accept Ctrl+V images
         onFiles: function (files) {},
         onReject: function (message) {}
       })
  ---------------------------------------------------------- */

  // Stop a stray drop anywhere else from navigating away from the page.
  ['dragover', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!e.target.closest || !e.target.closest('[data-drop]')) e.preventDefault();
    });
  });

  PB.createDropzone = function (el, opts) {
    opts = opts || {};
    var input = opts.input || el.querySelector('input[type="file"]');
    var depth = 0;

    function reject(message) {
      if (opts.onReject) opts.onReject(message);
      else PB.toast(message);
    }

    function handle(fileList) {
      var all = Array.prototype.slice.call(fileList || []);
      if (!all.length) return;

      var images = all.filter(PB.isImage);
      if (!images.length) {
        reject('That doesn\'t look like an image. Try a JPG, PNG, WebP, GIF, AVIF, BMP, SVG or HEIC file.');
        return;
      }
      if (images.length < all.length) {
        PB.toast('Skipped ' + (all.length - images.length) + ' non-image file' +
                 (all.length - images.length === 1 ? '' : 's'));
      }
      if (!opts.multiple) images = images.slice(0, 1);
      if (opts.onFiles) opts.onFiles(images);
    }

    function onDragEnter(e) {
      e.preventDefault();
      depth++;
      el.classList.add('is-dragover');
    }
    function onDragOver(e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
    function onDragLeave() {
      depth = Math.max(0, depth - 1);
      if (!depth) el.classList.remove('is-dragover');
    }
    function onDrop(e) {
      e.preventDefault();
      depth = 0;
      el.classList.remove('is-dragover');
      if (e.dataTransfer) handle(e.dataTransfer.files);
    }
    function onClick(e) {
      // The visible label already opens the picker; don't fire twice.
      if (!input || e.target.closest('label, a, button')) return;
      input.click();
    }
    function onChange() {
      handle(input.files);
      input.value = '';
    }
    function onPaste(e) {
      if (!e.clipboardData) return;
      var files = Array.prototype.slice.call(e.clipboardData.files || []);
      if (files.length) { e.preventDefault(); handle(files); }
    }

    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    el.addEventListener('click', onClick);
    if (input) input.addEventListener('change', onChange);
    if (opts.paste !== false) document.addEventListener('paste', onPaste);

    return {
      accept: handle,
      destroy: function () {
        el.removeEventListener('dragenter', onDragEnter);
        el.removeEventListener('dragover', onDragOver);
        el.removeEventListener('dragleave', onDragLeave);
        el.removeEventListener('drop', onDrop);
        el.removeEventListener('click', onClick);
        if (input) input.removeEventListener('change', onChange);
        document.removeEventListener('paste', onPaste);
      }
    };
  };

  /* ----------------------------------------------------------
     Homepage hero

     Reads the file locally, reports what it found, then stashes
     it so whichever tool you pick already has it.
  ---------------------------------------------------------- */

  function initHero() {
    var root = document.querySelector('[data-drop]');
    if (!root || !root.querySelector('[data-drop-idle]')) return;

    var idle = root.querySelector('[data-drop-idle]');
    var loaded = root.querySelector('[data-drop-loaded]');
    var errorEl = root.querySelector('[data-drop-error]');
    var thumb = root.querySelector('[data-drop-thumb]');
    var nameEl = root.querySelector('[data-drop-name]');
    var dimsEl = root.querySelector('[data-drop-dims]');
    var typeEl = root.querySelector('[data-drop-type]');
    var sizeEl = root.querySelector('[data-drop-size]');
    var clearBtn = root.querySelector('[data-drop-clear]');
    var thumbUrl = null;

    function showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    function hideError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    function reset() {
      if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrl = null; }
      thumb.innerHTML = '';
      loaded.hidden = true;
      idle.hidden = false;
      hideError();
      PB.clearHandoff();
    }

    var zone = PB.createDropzone(root, {
      multiple: true,
      onReject: showError,
      onFiles: function (files) {
        hideError();
        var first = files[0];

        PB.decodeImage(first).then(function (img) {
          if (thumbUrl) URL.revokeObjectURL(thumbUrl);
          thumbUrl = URL.createObjectURL(first);

          var el = document.createElement('img');
          el.src = thumbUrl;
          el.alt = 'Preview of ' + first.name;
          thumb.innerHTML = '';
          thumb.appendChild(el);

          nameEl.textContent = files.length > 1
            ? first.name + '  + ' + (files.length - 1) + ' more'
            : first.name;
          dimsEl.textContent = img.width.toLocaleString() + ' × ' + img.height.toLocaleString();
          typeEl.textContent = PB.typeLabel(first);
          sizeEl.textContent = files.length > 1
            ? PB.formatBytes(files.reduce(function (t, f) { return t + f.size; }, 0)) + ' total'
            : PB.formatBytes(first.size);

          img.release();
          idle.hidden = true;
          loaded.hidden = false;

          return PB.putHandoff(files);
        }).catch(function (err) {
          showError(err.message ||
            'That file couldn\'t be opened. It may be damaged, or in a format this browser doesn\'t read.');
        });
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        reset();
      });
    }

    window.addEventListener('pagehide', function () {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    });

    return zone;
  }

  /* ----------------------------------------------------------
     Odds and ends
  ---------------------------------------------------------- */

  function initYear() {
    var els = document.querySelectorAll('[data-year]');
    var year = String(new Date().getFullYear());
    for (var i = 0; i < els.length; i++) els[i].textContent = year;
  }

  // Fills any ad slot that has an <ins> in it, once the AdSense
  // script is actually on the page. Harmless while it's commented out.
  function initAds() {
    if (!window.adsbygoogle) return;
    var slots = document.querySelectorAll('.ad-slot ins.adsbygoogle:not([data-adsbygoogle-status])');
    for (var i = 0; i < slots.length; i++) {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (err) {}
    }
  }

  /* ----------------------------------------------------------
     Boot
  ---------------------------------------------------------- */

  initTheme(); // before paint where possible, to avoid a flash

  PB.ready(function () {
    initNav();
    initHero();
    initYear();
    initAds();
  });

  window.Pixelbench = PB;
})();
