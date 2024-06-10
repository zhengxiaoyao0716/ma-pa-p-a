/**
 * Magic Palette for Pixel Arts.
 * https://github.com/zhengxiaoyao0716/ma-pa-p-a
 */

/**
 * @typedef {import("./types").Palette} Palette
 * @typedef {import("./types").Archive} Archive
 */

/** Magic Palette for Pixel Arts Application */
export class App extends EventTarget {
  /** @type {{[code: string]: Palette | { count: number, split: Palette[] }}} */
  palettes = {};
  paletteNum = 0;
  /** @type {{[name: string]: Archive}} */
  archives = {};
  archiveNum = 0;

  dialog = new Dialog();

  constructor({
    imageLimit = 16, // 16MB
    chunkSize = 1 << 20, // 1024 * 1024
    workersNum = 8,
  } = {}) {
    super();
    this.imageLimit = imageLimit;
    this.chunkSize = chunkSize;
    this.workersNum = workersNum;
  }

  //#region worker pools

  /** @type {WorkerService[]} */ workers = [];

  get workersNum() {
    return this.workers.length;
  }
  set workersNum(num) {
    WorkerService.resize(this, num);
  }

  /** @type {import("./types").MsgRequest} */
  request = (type, body) => {
    const worker = WorkerService.idle(this.workers);
    worker.postMessage({ type, body }, body.trans);
  };

  /** @type {import("./types").MsgHandlers} */
  handlers = {
    parseGzip: ({ name, buffer }) => {
      this.log("info", "TODO on parsed gzip", name, buffer);
    },

    parseImage: ({ arch, chunk, data, plte, trans: [output, count] }) => {
      const colorNum = plte.byteLength >> 2;
      if (colorNum > 256) {
        this.log(
          "error",
          `too many colors, name: ${arch}, limit: ${256}, count: ${colorNum}+`
        );
        return;
      }
      const { ctx, chunks } = this.archives[arch];
      const { rect } = chunks[chunk];
      chunks[chunk] = { rect, texture: { data, plte } };

      const colors = new DataView(plte.buffer);
      const counter = new DataView(count);
      for (let i = 0; i < colors.byteLength; i += 4) {
        const color = colors.getUint32(i);
        const count = counter.getUint32(i, true);
        const palette = this.computePalette(color);
        palette.count += count;
        const refer = palette.refer[arch] ?? (palette.refer[arch] = []);
        refer.push({ chunk, offset: i });
      }
      const detail = this.iterPalettes(this.sortedPalettes());
      this.dispatchEvent(new CustomEvent("updatePalette", { detail }));
      ctx.drawImage(output, ...rect);
    },

    updateChunk: ({ arch, chunk, data, plte, trans: [output] }) => {
      const { ctx, chunks } = this.archives[arch];
      const { rect } = chunks[chunk];
      chunks[chunk] = { rect, texture: { data, plte } };
      ctx.clearRect(...rect);
      ctx.drawImage(output, ...rect);
    },

    dumpPalettes: ({ name, url }) => {
      dumpFile(name, url);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };

  //#endregion

  //#region palette operate

  sortedPalettes() {
    return Object.values(this.palettes).sort(
      ({ count: count1 }, { count: count2 }) => {
        return count1 > count2 ? -1 : count1 < count2 ? 1 : 0;
      }
    );
  }

  /** @param {(Palette | { count: number, split: Palette[] })[]} palettes . */
  *iterPalettes(palettes) {
    for (const palette of palettes) {
      if ("code" in palette) yield palette;
      else yield* palette.split;
    }
  }

  /** @type {{[arch: string]: Set<number> }} */ dirtyChunks = {};

  flushDirty() {
    for (const [arch, chunks] of Object.entries(this.dirtyChunks)) {
      const archives = this.archives[arch];
      for (const chunk of chunks) {
        const { rect, texture } = archives.chunks[chunk];
        if (texture == null) continue;
        const { data, plte } = texture;
        this.request("updateChunk", {
          arch,
          chunk,
          width: rect[2],
          height: rect[3],
          data,
          plte,
          trans: [plte.buffer, data.buffer],
        });
      }
    }
    this.dirtyChunks = {};
    const detail = this.iterPalettes(this.sortedPalettes());
    this.dispatchEvent(new CustomEvent("updatePalette", { detail }));
  }

  /**
   * get palette.
   *
   * @param {string} code .
   * @returns {Palette | undefined}
   */
  getPalette(code) {
    if (code.length === 8) return this.palettes[code];
    /** @type {{count: number, split: Palette[]}} */
    const parent = this.palettes[code.slice(0, 8)];
    const i = Number.parseInt(code.slice(8), 16);
    return parent.split[i];
  }

  /** @param {number} color . */
  computePalette(color) {
    const code = color.toString(16).toUpperCase().padStart(8, "0");
    const palette = this.palettes[code];
    if (palette == null) {
      this.paletteNum++;
      return (this.palettes[code] = {
        code,
        color,
        count: 0,
        refer: {},
      });
    }
    if ("code" in palette) {
      if (palette.dirty === undefined) return palette;
      palette.code = `${code}00`;
      this.palettes[code] = { count: palette.count, split: [palette] };
    }
    /** @type {{count: number, split: Palette[]}} */
    const parent = this.palettes[code];
    for (const palette of parent.split) {
      if (palette.dirty === undefined) return palette;
    }
    this.paletteNum++;
    let count = 0;
    const children = {
      code: `${code}${parent.split.length
        .toString(16)
        .toUpperCase()
        .padStart(2, "0")}`,
      color,
      get count() {
        return count;
      },
      set count(value) {
        count = value;
        parent.count += value;
      },
      refer: {},
    };
    parent.split.push(children);
    return children;
  }

  /** @param {string} code . */
  splitColor(code) {
    if (code.length > 8) {
      this.splitColor(code.slice(0, 8));
      return;
    }
    /** @type {Palette} */
    const palette = this.palettes[code];
    if (palette == null) return;
    this.log("info", "TODO split color", code, palette);
  }

  /**
   * update color.
   *
   * @param {string} code .
   * @param {number} color .
   */
  updateColor(code, color) {
    const palette = this.getPalette(code);
    if (palette == null) return;
    const dirty = color === palette.color ? undefined : color;
    if (dirty === palette.dirty) return;
    palette.dirty = dirty;
    const rgba = parseRGBA(color);

    for (const [arch, refer] of Object.entries(palette.refer)) {
      const chunks =
        this.dirtyChunks[arch] ?? (this.dirtyChunks[arch] = new Set());
      const archives = this.archives[arch];
      for (const { chunk, offset } of refer) {
        const { texture } = archives.chunks[chunk];
        if (texture == null) continue;
        chunks.add(chunk);
        const { plte } = texture;
        plte.set(rgba, offset);
      }
    }
  }

  //#endregion

  /**
   * parse image blob.
   *
   * @param {string} name .
   * @param {Blob} blob .
   */
  parseImageBlob(name, blob) {
    if (name in this.archives) {
      this.log("warn", `duplicated image, name: ${name}`);
      return;
    }
    const bitmap = window.createImageBitmap(blob);

    const canvas = document.createElement("canvas");
    canvas.title = name;
    canvas.classList.add("loading");
    /** @type {Archive} */
    const archive = { ctx: canvas.getContext("2d"), chunks: [] };
    this.archiveNum++;
    this.archives[name] = archive;
    this.dispatchEvent(new CustomEvent("createImage", { detail: archive }));

    bitmap.then((bitmap) => {
      const { canvas } = archive.ctx;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.classList.remove("loading");

      const arch = canvas.title;
      for (const rect of chunkRects(bitmap, this.chunkSize)) {
        const source = window.createImageBitmap(bitmap, ...rect);
        const id = archive.chunks.length;
        archive.chunks.push({ rect });
        source.then((source) => {
          this.request("parseImage", {
            arch,
            chunk: id,
            trans: [source],
          });
          source.close();
        });
      }
      bitmap.close();
    });
  }

  /**
   * parse blob.
   *
   * @param {string} name .
   * @param {Blob} blob .
   */
  parseBlob(name, blob) {
    if (blob.size > this.imageLimit << 20) {
      const size = (blob.size / 1024).toFixed(2);
      this.log(
        "error",
        `file too large, size: ${size}KB, max: ${this.imageLimit}MB`
      );
      return;
    }
    const index = name.lastIndexOf(".");
    switch (name.slice(1 + index)) {
      case "png":
      case "gif":
      case "webp": {
        this.parseImageBlob(name, blob);
        break;
      }
      case "mppa": {
        const url = URL.createObjectURL(blob);
        this.request("parseGzip", { url, name });
        break;
      }
      default: {
        this.log("warn", `unknown type, name: ${name}`);
        break;
      }
    }
  }

  clearAll() {
    this.palettes = {};
    this.thiNum = 0;
    this.archives = {};
    this.thiNum = 0;
    this.dispatchEvent(new CustomEvent("clear"));
  }

  /** @param {FileList} sources . */
  handleUpload(sources) {
    // this.clearCache();
    for (const source of sources) {
      this.parseBlob(source.name, source);
    }
    this.dispatchEvent(new CustomEvent("uploaded", { detail: sources }));
  }

  /**
   * log message.
   *
   * @typedef {"error" | "warn" | "info" | "debug"} LogLevel .
   *
   * @param {LogLevel} level .
   * @param {string} message .
   * @param {...object[]} [payload] .
   */
  log(level, message, ...varargs) {
    console[level](`[ma-pa-p-a] ${message}`, ...varargs);
    this.dispatchEvent(new CustomEvent("log", { detail: { level, message } }));
  }

  dump() {
    const layers = [,];
    const palettes = Array.from(this.iterPalettes(this.sortedPalettes()));
    const colors = palettes.flatMap(({ color }) => parseRGBA(color));
    const plte = new Uint8ClampedArray(colors.length * layers.length);
    let offset = 0;
    for (const _layer of layers) {
      for (const color of colors) {
        plte[offset++] = color;
      }
    }
    const salt = (new Date().getTime() & 0xffffff)
      .toString(16)
      .padStart(6, "0");
    const width = palettes.length;
    const height = layers.length;
    const dumpPalettes = () => {
      this.request("dumpPalettes", {
        name: `mppa-${salt}_${width}x${height}.plte`,
        plte,
        width,
        height,
        trans: [plte.buffer],
      });
    };
    const dumpArchives = () => {
      // TODO
    };
    return {
      palettes: dumpPalettes,
      archives: dumpArchives,
      exportAll: () => {
        dumpPalettes();
        dumpArchives();
      },
    };
  }
}

//

class WorkerService {
  /**
   * resize worker services.
   *
   * @param {App} app .
   * @param {number} num .
   */
  static resize(app, num) {
    const { length } = app.workers;
    if (num <= length) {
      for (let i = num; i < length; i++) {
        const service = app.workers.pop();
        service._safelyTerminate(app);
      }
      return;
    }
    for (let i = length; i < num; i++) {
      const service = new WorkerService();
      service._handle(app);
      app.workers.push(service);
    }
  }

  /**
   * find an idle work.
   *
   * @param {WorkerService[]} services .
   * @returns {Worker} .
   */
  static idle(services) {
    let idle = services[0];
    for (let i = 1; i < services.length; i++) {
      const service = services[i];
      if (service._taskCount < idle._taskCount) {
        idle = service;
      }
    }
    idle._taskCount++;
    return idle.worker;
  }

  static _indexer = 0;
  static workerUrl = new URL("./ma-pa-p-a.worker.js", import.meta.url);

  constructor() {
    this.id = WorkerService._indexer++;
    const name = `MaPaPA-Worker#${this.id}`;
    this.worker = new Worker(WorkerService.workerUrl, { name });
  }

  _taskCount = 0;

  /** @param {App} app . */
  _handle(app) {
    this.worker.addEventListener(
      "message",
      /** @param {MessageEvent<{type: import("./types").MsgType, resp?: {}, error?: object}>} event . */
      ({ data: { type, resp, error } }) => {
        this._taskCount--;
        if (error) {
          app.log("error", `worker request failed, type: ${type}`, error);
        } else {
          app.handlers[type](resp);
        }
      }
    );
  }

  /** @param {App} app . */
  _safelyTerminate(app) {
    if (this._taskCount <= 0) {
      this.worker.terminate();
      app.log("debug", `worker terminated, id: ${this.id}`);
      return;
    }
    this.worker.addEventListener("message", () => {
      setTimeout(() => {
        if (this._taskCount > 0) return;
        this.worker.terminate();
        app.log("debug", `worker safely exited, id: ${this.id}`);
      }, 0);
    });
  }
}

class Dialog extends EventTarget {
  /**
   * @typedef {{
   *   html: () => string,
   *   show: undefined | ($dialog: HTMLDivElement) => void,
   *   actions: undefined | {[id: string]: ($dialog: HTMLDivElement) => void},
   * }} Content
   */
  /** @type {Content["actions"]} */
  _actions = undefined;
  dblclick = window.matchMedia("(pointer: coarse)").matches;

  constructor() {
    super();
    this.$dialog = document.createElement("div");
    this.$dialog.classList.add("dialog");
    this.$dialog.addEventListener("click", (event) => {
      if (this._actions == null) return;
      if (event.target === event.currentTarget) return;
      if (!(event.target instanceof HTMLElement)) return;
      const { id } = event.target;
      const action = this._actions[id];
      if (action == null) return;
      event.preventDefault();
      event.stopPropagation();
      action(event.currentTarget);
      this.hide();
    });
    this.$dialog.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  /**
   * show dialog.
   *
   * @param {{[id: string]: string}} items .
   * @param {Content} content .
   */
  show(items, { html, show, actions }) {
    this.$dialog.innerHTML = `${html()}${Object.entries(items)
      .map(this.menuItem)
      .join("")}`;
    if (show != null) show(this.$dialog);
    this._actions = actions;
    this.$dialog.classList.remove("fade-out");
    this.dispatchEvent(new CustomEvent("show"));
  }

  hide() {
    this.$dialog.innerHTML = "";
    this.dispatchEvent(new CustomEvent("hide"));
    this.$dialog.classList.add("fade-out");
  }

  /**
   * bind listeners.
   *
   * @param {HTMLAnchorElement} $trigger .
   * @param {{[id: string]: string}} items .
   * @param {(event: MouseEvent) => Content | undefined} handler .
   */
  listen($trigger, items, handler) {
    /** @type {{t: number | undefined, x: number, y: number}} */
    const clickAt = { t: undefined, x: 0, y: 0 };
    const clearTimer = () => {
      if (clickAt.t === undefined) return;
      window.clearTimeout(clickAt.t);
      clickAt.t = undefined;
    };

    /** @param {MouseEvent} event . */
    const contextmenu = (event) => {
      clearTimer();
      event.preventDefault();
      event.stopPropagation();
      const content = handler(event);
      if (content != null) this.show(items, content);
    };
    $trigger.addEventListener("contextmenu", contextmenu);
    // $trigger.addEventListener("dblclick", contextmenu);

    $trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const content = handler(event);
      if (content == null) return;
      if (this.dblclick && clickAt.t !== undefined) {
        const move =
          Math.pow(event.x - clickAt.x, 2) + Math.pow(event.y - clickAt.y, 2);
        clearTimer();
        if (move < /* < 10^2 */ 100) {
          this.show(items, content);
          return;
        }
      }
      if (content.actions == null || content.actions.length === 0) return;
      // else
      clearTimer();

      for (const id in Dialog.hotkeys) {
        if (event[`${id}Key`] !== true) continue;
        const action = content.actions[id];
        if (action) action(this.$dialog);
        return;
      }
      const click = content.actions["click"];
      if (click == null) {
        this.show(items, content);
        return;
      }
      if (!this.dblclick) {
        const show = click(this.$dialog);
        if (show) this.show(items, content);
        return;
      }
      clickAt.x = event.x;
      clickAt.y = event.y;
      clickAt.t = setTimeout(() => {
        clickAt.t = undefined;
        const show = content.actions.click(this.$dialog);
        if (show) this.show(items, content);
      }, 200);
    });
  }

  /**
   * create menu item.
   *
   * @param {[name: string, label: string]} item .
   * @returns {string} html
   */
  menuItem([id, label]) {
    const hotkey =
      id in Dialog.hotkeys ? `<small>${Dialog.hotkeys[id]}</small>` : "";
    return `<a id="${id}" href="javascript:void(0);"><span>${label}</span>${hotkey}</a>`;
  }

  static hotkeys = {
    ctrl: "Ctrl+Click",
    shift: "Shift+Click",
    alt: "Alt+Click",
  };

  /** @param {Dialog} dialog . */
  static modal(dialog) {
    const $modal = document.createElement("div");
    $modal.classList.add("modal");
    $modal.appendChild(dialog.$dialog);

    /** @type {number | undefined} */ let timer;
    dialog.addEventListener(
      "show",
      ({
        currentTarget: {
          $dialog: { parentElement: $modal },
        },
      }) => {
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
        $modal.classList.remove("fade-out");
        $modal.classList.add("show");
      }
    );
    dialog.addEventListener(
      "hide",
      ({
        currentTarget: {
          $dialog: { parentElement: $modal },
        },
      }) => {
        if (timer !== undefined) return;
        $modal.classList.add("fade-out");
        timer = window.setTimeout(() => {
          timer = undefined;
          $modal.classList.remove("fade-out");
          $modal.classList.remove("show");
        }, 300);
      }
    );
    /** @param {MouseEvent} event . */
    const triggerHide = (event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      event.stopPropagation();
      dialog.hide();
    };
    $modal.addEventListener("mouseup", triggerHide);
    $modal.addEventListener("contextmenu", triggerHide);
    return $modal;
  }
}

//#region utils

/** @param {number} color . */
function parseRGBA(color) {
  let value = color >>> 0;
  const a = value & 0xff;
  value >>>= 8;
  const b = value & 0xff;
  value >>>= 8;
  const g = value & 0xff;
  value >>>= 8;
  const r = value & 0xff;
  return [r, g, b, a];
}

/**
 * dump file.
 *
 * @param {string} name .
 * @param {string} url .
 */
function dumpFile(name, url) {
  const $save = document.createElement("a");
  $save.href = url;
  $save.download = name;
  $save.click();
}

/**
 * iter chunks.
 *
 * @param {{width: number, height: number}} imageSize .
 * @param {number} chunkSize .
 * @returns {Iterable<import("./types").Rect>} chunk rects
 */
function* chunkRects({ width, height }, chunkSize) {
  if (width > height) {
    const chunks = chunkRects({ width: height, height: width });
    for (const [y, x, h, w] of chunks) {
      yield [x, y, w, h];
    }
    return;
  }
  const num = Math.ceil((width * height) / chunkSize);
  if (num <= 1.2 /* tolerance 1/5 */) {
    yield [0, 0, width, height];
    return;
  }
  const h = Math.ceil(height / num);
  let y = 0;
  for (; y < height - h; y += h) {
    yield [0, y, width, h];
  }
  if (y < height) yield [0, y, width, height - y];
}

/**
 * listen drop upload
 *
 * @param {App} app .
 * @param {HTMLElement} $root .
 */
function listenUpload(app, $root) {
  /** @type {EventTarget | null} */ let target = null;
  $root.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();
    target = event.target;
    const isFile = event.dataTransfer.types.some((type) => type === "Files");
    if (isFile) event.currentTarget.classList.add("dragover");
  });
  $root.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  $root.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (target === event.target) {
      target = null;
      event.currentTarget.classList.remove("dragover");
    }
  });
  $root.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    target = null;
    event.currentTarget.classList.remove("dragover");
    app.handleUpload(event.dataTransfer.files);
  });
}

/**
 * fetch url and parse the content.
 *
 * @param {App} app .
 * @param {string} query .
 */
function fetchAndParse(app, query) {
  const params = new URLSearchParams(window.location.search);
  for (const value of params.getAll(query)) {
    const url = new URL(window.decodeURI(value), import.meta.url);
    app.log("debug", `auto fetch and parse, url: ${url}`);
    fetch(url, { mode: "cors" }).then(async (resp) => {
      if (!resp.ok) return;
      const blob = resp.blob();
      const index = resp.url.lastIndexOf("/");
      const name = resp.url.slice(1 + index);
      app.parseBlob(name, await blob);
    });
  }
}

/**
 * create palette color element.
 *
 * @param {number} index .
 * @param {Palette} palette .
 * @returns {HTMLAnchorElement} .
 */
function paletteColor(index, { code, color, count, dirty }) {
  const $color = document.createElement("a");
  $color.id = `color${code}`;
  $color.title = `${index}. ${code}: ${
    count < 1000
      ? `${count}`
      : count < 1000000
      ? `${(count / 1000).toFixed(2)}K`
      : `${(count / 1000000).toFixed(2)}M`
  }`;
  $color.innerHTML = `<span/>`;
  const rgba = dirty || color;
  if ((rgba & 0xff) < 0xff) {
    $color.classList.add("tp-grid");
  }
  const hex = `#${rgba.toString(16).padStart(8, "0")}`;
  $color.style.setProperty("--color", hex);
  const disable = dirty === 0;
  if (disable) $color.classList.add("cross-out");
  else $color.classList.remove("cross-out");
  $color.href = "javascript:void(0);";
  return $color;
}

//#endregion

//#region layout

//prettier-ignore
const menuIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <g fill="var(--color)">${[5, 12, 19].map((x) => `<circle cx="${x}" cy="12" r="2" />`)}</g>
</svg>`;

/**
 * create titlebar.
 *
 * @param {App} app .
 * @returns titlebar element
 */
function createTitlebar(app) {
  const $upload = document.createElement("label");
  $upload.id = "upload";
  $upload.innerHTML = `<input type="file" multiple /><span class="drag-tips">Drag the image here.</span>`;
  $upload.addEventListener("input", (event) =>
    app.handleUpload(event.target.files)
  );

  const $colors = document.createElement("div");
  $colors.classList.add("colors", "hide");
  app.addEventListener("clear", () => {
    $upload.classList.remove("hide");
    $colors.innerHTML = "";
    $colors.classList.add("hide");
  });
  app.addEventListener(
    "updatePalette",
    /** @param {CustomEvent<Iterable<Palette>>} event . */ ({
      detail: palettes,
    }) => {
      $colors.innerHTML = "";
      let i = 0;
      for (const palette of palettes) {
        const $color = paletteColor(++i, palette);
        $colors.appendChild($color);
      }
      if (i > 0) {
        $upload.classList.add("hide");
        $colors.classList.remove("hide");
      }
    }
  );
  app.dialog.listen(
    $colors,
    { ctrl: "Focus", shift: "Toggle", alt: "Exclude" },
    ({ target: $color }) => {
      if (!($color instanceof HTMLAnchorElement)) return;
      const code = $color.id.slice(5);
      const hex = $color.style.getPropertyValue("--color");
      const color = Number.parseInt(hex.slice(1), 16);
      const rgba = parseRGBA(color);

      // TODO
      const html = () => `<div class="titlebar header hr">
        <span class="color tp-grid" style="--color: ${hex};"></span>
        <label>
          <span>${$color.title}</span>
          <small>rgba(${rgba.join(", ")})</small>
        </label>
      </div>
      <div id="colorPicker">
        <label id="rgb">
          <input type="color" value="${hex.slice(0, 7)}" />
          <pre>${hex.slice(0, 7)}</pre>
        </label>
        <label id="alpha">
          <input type="range" min="0" max="255" value="${rgba[3]}" />
          <pre>A: ${rgba[3]}</pre>
        </label>
      </div>
      <a id="submit" class="footer" href="javascript:void(0);">Submit</a>`;

      /** @param {HTMLDivElement} $dialog . */
      const show = ($dialog) => {
        const $rgb = $dialog.querySelector("label#rgb>input");
        $rgb.addEventListener("input", (event) => {
          const value = event.currentTarget.value;
          $dialog.querySelector("label#rgb>pre").innerHTML = value;
        });
        const $alpha = $dialog.querySelector("label#alpha>input");
        $alpha.addEventListener("input", (event) => {
          const value = event.currentTarget.value;
          const text = `A: ${value.padStart(3, " ")}`;
          $dialog.querySelector("label#alpha>pre").innerHTML = text;
        });
        const $submit = $dialog.querySelector("#submit");
        $submit.addEventListener("click", () => {
          app.dialog.hide();
          const rgb = Number.parseInt($rgb.value.slice(1), 16);
          const alpha = Number.parseInt($alpha.value);
          const color = rgb * 256 + alpha;
          app.updateColor(code, color);
          app.flushDirty();
          app.log(
            "info",
            `color updated, code: ${code}, color: #${color.toString(16)}`
          );
        });
      };

      const toggle = () => {
        const disable = !$color.classList.contains("cross-out");
        app.updateColor(code, disable ? 0x00000000 : color);
        app.flushDirty();
        app.log("info", `color ${disable ? "disabled" : "enabled "}: ${code}`);
      };
      const highlight = (focus) => {
        for (const $color of $colors.children) {
          if (!($color instanceof HTMLAnchorElement)) continue;
          if (!$color.id.startsWith("color")) continue;
          const code = $color.id.slice(5);
          const hex = $color.style.getPropertyValue("--color");
          const color = Number.parseInt(hex.slice(1), 16);
          app.updateColor(code, focus ? 0x00000000 : color);
        }
        app.updateColor(code, focus ? color : 0x00000000);
        app.flushDirty();
        app.log("info", `color ${focus ? "focused " : "excluded"}: ${code}`);
      };
      return {
        html,
        show,
        actions: {
          ctrl: () => highlight(true),
          shift: toggle,
          alt: () => highlight(false),
        },
      };
    }
  );

  const $menu = document.createElement("a");
  $menu.id = "menu";
  $menu.href = "javascript:void(0);";
  $menu.title = "Expand menu";
  $menu.innerHTML = menuIcon;
  $menu.classList.add("icon");
  app.dialog.listen(
    $menu,
    {
      ctrl: "Export all",
      palettes: "- Dump palettes",
      archives: "- Dump archives",
      clear: "Clear all",
    },
    () => {
      const layers = [, , , , ,]; // TODO
      const html = () => `<label class="header hr">
        <span title="Prev:    Alt+Click\nNext: Shift+Click">
          <span>Layer:</span>
          <input id="layer" type="number" min="1" max="${layers.length}" value="1">
          <span>/</span>
          <span class="titlebar layer-num">
            <button id="delete" title="delete layer">-</button>
            <span>${layers.length}</span>
            <button id="create" title="create layer">+</button>
          </span>
        </span>
        <small>${app.paletteNum} color in ${app.archiveNum} archive</small>
      </label>`;
      /** @param {HTMLDivElement} $dialog . */
      const show = ($dialog) => {
        const $input = $dialog.querySelector("input");
        $input.addEventListener("change", (event) => {
          app.log("info", `change ${event.target.value}`);
        });
      };
      const prevLayer = () => {
        app.log("info", "prev");
      };
      const nextLayer = () => {
        app.log("info", "next");
      };
      return {
        html,
        show,
        actions: {
          ctrl: () => app.dump().exportAll(),
          palettes: () => app.dump().palettes(),
          archives: () => app.dump().archives(),
          clear: () => app.clearAll(),
          shift: nextLayer,
          alt: prevLayer,
        },
      };
    }
  );

  const $panel = document.createElement("div");
  $panel.id = "titlebar";
  $panel.appendChild($upload);
  $panel.appendChild($colors);
  $panel.appendChild($menu);
  return $panel;
}

/**
 * create archives.
 *
 * @param {App} app .
 * @returns archives element
 */
function createArchives(app) {
  const $images = document.createElement("div");
  $images.id = "images";
  $images.classList.add("tp-grid");
  app.addEventListener("clear", () => {
    $images.innerHTML = "";
  });
  app.addEventListener(
    "createImage",
    /** @param {CustomEvent<Archive>} event . */
    ({ detail: { ctx } }) => {
      $images.appendChild(ctx.canvas);
    }
  );

  const $selectArea = document.createElement("div");
  $selectArea.id = "selectArea";
  const selection = {
    name: "",
    posX: 0,
    posY: 0,
    topY: 0,
    type: "",
    /** @type {import("./types").Rect | null} */
    rect: null,
  };
  /** @param {MouseEvent | TouchEvent} event . */
  function drawArea(event, create = false) {
    if (!event.cancelable) {
      // scrolling
      $selectArea.classList.remove("show");
      selection.name = "";
      return;
    }
    const $canvas = event.target;
    if (!($canvas instanceof HTMLCanvasElement)) return selection.rect;
    const mouse = event instanceof TouchEvent ? event.touches[0] : event;
    if (mouse == null) return selection.rect;
    const { left, top } = $canvas.parentElement.getBoundingClientRect();
    const { scrollTop } = $canvas.parentElement.parentElement;
    const { clientX, clientY } = mouse;

    if (selection.name !== $canvas.title) {
      if (!create) return null;
      selection.name = $canvas.title;
      selection.posX = clientX;
      selection.posY = clientY;
      selection.topY = scrollTop;
      $selectArea.style.left = `${clientX - left}px`;
      $selectArea.style.top = `${clientY - top}px`;
      $selectArea.style.width = `0px`;
      $selectArea.style.height = `0px`;
      $selectArea.classList.add("show");
      return (selection.rect = null);
    }
    if (event instanceof TouchEvent && event.touches.length >= 2) {
      event.preventDefault();
      event.stopPropagation();
      const { clientX: posX, clientY: posY } =
        event.touches[event.touches.length - 1];
      selection.posX = posX;
      selection.posY = posY;
    }
    const { posX, posY: _posY, topY } = selection;
    const posY = _posY + topY - scrollTop;
    const [x, endX] = clientX < posX ? [clientX, posX] : [posX, clientX];
    const [y, endY] = clientY < posY ? [clientY, posY] : [posY, clientY];
    const w = endX - x;
    const h = endY - y;
    $selectArea.style.left = `${x - left}px`;
    $selectArea.style.top = `${y - top}px`;
    $selectArea.style.width = `${w}px`;
    $selectArea.style.height = `${h}px`;
    return (selection.rect = [x, y, w, h]);
  }
  $images.addEventListener("mousemove", drawArea);
  $images.addEventListener("mouseout", drawArea);

  /**
   * submit area.
   *
   * @param {string} arch .
   * @param {string} type .
   * @param {import("./types").Rect} rect .
   */
  function submitArea(arch, type, rect) {
    $selectArea.classList.remove("show");
    selection.name = selection.type = "";
    selection.rect = null;
    // TODO
    app.log(
      "info",
      `submit area, ${arch} - ${type}: ${rect.map((i) => i.toFixed(0))}`
    );
  }
  const menuItems = {
    ctrl: "Zoom area",
    shift: "Split area",
    alt: "Erase area",
  };
  /** @param {MouseEvent | TouchEvent} event . */
  const menuHandler = (event) => {
    const arch =
      event.target instanceof HTMLCanvasElement
        ? event.target.title
        : selection.name;
    if (!arch) return;
    const { ctx, chunks } = app.archives[arch];
    const { width, height } = ctx.canvas;
    const html = () => `<label class="header hr">
      <span>${arch}</span>
      <small>${width}x${height} with ${chunks.length} chunk</small>
    </label>`;

    const rect = drawArea(event);
    /** @param {string} type . */
    function selectType(type) {
      if (rect == null) selection.type = type;
      else submitArea(arch, type, rect);
    }
    return {
      html,
      show: () => {
        // $selectArea.classList.remove("show");
        selection.name = selection.type = "";
        selection.rect = null;
      },
      actions: {
        ctrl: () => selectType("zoom"),
        shift: () => selectType("split"),
        alt: () => selectType("erase"),
        click: () => {
          if (rect == null) return;
          const { name, type } = selection;
          if (type) {
            submitArea(name, type, rect);
            return;
          }
          return /* show menu */ true;
        },
      },
    };
  };

  $images.addEventListener("touchstart", (event) => drawArea(event, true));
  $images.addEventListener("touchmove", (event) => drawArea(event));
  $images.addEventListener("touchend", (event) => {
    if (!event.cancelable) return;
    if (event.touches.length > 0) {
      const { clientX: posX, clientY: posY } =
        event.changedTouches[event.changedTouches.length - 1];
      selection.posX = posX;
      selection.posY = posY;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const content = menuHandler(event);
    if (content != null) app.dialog.show(menuItems, content);
  });
  $images.addEventListener("mousedown", (event) => {
    if (event.buttons === 1) drawArea(event, true);
  });
  app.dialog.listen($images, menuItems, menuHandler);
  app.dialog.addEventListener("hide", () => {
    $selectArea.classList.remove("show");
  });

  const $panel = document.createElement("div");
  $panel.id = "archives";
  $panel.appendChild($images);
  $panel.appendChild($selectArea);
  return $panel;
}

/**
 * create messages.
 *
 * @param {App} app .
 * @param {boolean} silent .
 * @returns messages box
 */
function createMessages(app, silent) {
  const $box = document.createElement("div");
  $box.id = "messages";

  /**
   * show message.
   *
   * @param {LogLevel} level .
   * @param {string} message .
   * @param {number} [delay=3000] .
   */
  function showMessage(level, message, delay = 3000) {
    const $pre = document.createElement("pre");
    $pre.innerHTML = message;
    $pre.classList.add(level);
    $box.appendChild($pre);
    setTimeout(() => $pre.classList.add("fade-out"), delay);
    setTimeout(() => $pre.remove(), delay + 500);
  }
  app.addEventListener(
    "log",
    /** @param {CustomEvent<{level: LogLevel, message: string}>} */
    ({ detail: { level, message } }) => showMessage(level, message)
  );
  if (!silent) {
    fetch(new URL("./package.json", import.meta.url))
      .then((resp) => resp.json())
      .then(({ name, version, author, license, homepage }) => {
        const message = [
          `| ${name} v${version} ${author} |`,
          `|_ ${license} ${homepage} _|`,
        ].join("\n");
        console.info(message);
        showMessage("info", message, 1000);
      });
  }
  return $box;
}

/**
 * create style url.
 *
 * @param {string} [scope="mppa"] .
 */
function createStyle(scope = "mppa") {
  const $style = document.createElement("style");
  const url = new URL("./ma-pa-p-a.css", import.meta.url);
  if (scope === "mppa") {
    $style.innerHTML = `@import "${url}";`;
    return $style;
  }
  /* replace scope */
  if (createStyle.text === null) {
    createStyle.text = fetchStyle(url);
  }
  createStyle.text.then((text) => {
    $style.innerHTML = text.replace(/\.mppa/g, `.${scope}`);
  });
  return $style;
}
/** @type {Promise<string> | null} */
createStyle.text = null;
async function fetchStyle(url) {
  const resp = await fetch(`${url}?raw`);
  const text = await resp.text();
  if (text.startsWith(".mppa,")) return text;
  // restore transpiled content
  const blob = new Blob([text], { type: "application/javascript" });
  const src = URL.createObjectURL(blob);
  return (await import(/* @vite-ignore */ src)).default;
}
//#endregion

//#region usages

//

/* Traditional */

//

/**
 * render root.
 *
 * @param {App} app .
 * @param {HTMLElement | string} root root element or it's selector
 * @param {string} [query="parse"] uri query keyword for auto upload and parse file
 * @param {boolean} [silent=false] do not show package information.
 */
export function render(app, root = ".mppa", query = "fetch", silent = false) {
  const $root =
    root instanceof HTMLElement ? root : document.querySelector(root);
  $root.appendChild(createTitlebar(app));
  $root.appendChild(createArchives(app));
  $root.appendChild(createMessages(app, silent));
  $root.append(Dialog.modal(app.dialog));
  listenUpload(app, $root);
  if (query) fetchAndParse(app, query);
}

//

/* Inject Style */

//

/**
 * create root.
 *
 * @param {App} app .
 * @param {{id?: string, theme?: "light" | "dark", query?: string, silent?: boolean }} [props={}] .
 * @returns root element
 */
export function inject(
  app,
  { scope = "mppa", theme = "light", query = "fetch", silent = false } = {}
) {
  const $root = document.createElement("div");
  $root.classList.add(scope, theme);
  $root.appendChild(createStyle(scope));
  render(app, $root, query, silent);
  return $root;
}

//

/* Web Components */

//

/**
 * init web components.
 *
 * @param {{name?: string, mode?: "open" | "closed"}} [props={}] .
 */
export function init({ name = "ma-pa-p-a", mode = "closed" } = {}) {
  class HTMLMaPaPAElement extends HTMLElement {
    static observedAttributes = [
      "theme",
      "image-limit",
      "color-limit",
      "chunk-size",
      "workers-num",
    ];
    app = new App();

    connectedCallback() {
      const scope = this.getAttribute("scope") ?? "mppa";
      const theme = this.getAttribute("theme") ?? "light";
      const query = this.getAttribute("query") ?? "fetch";
      const silent =
        this.hasAttribute("silent") && this.getAttribute("silent") !== "false";
      const $root = inject(this.app, { scope, theme, query, silent });
      this.app.addEventListener(
        "updateTheme",
        /** @param {CustomEvent<"light" | "dark">} event . */ ({
          detail: theme = "light",
        }) => {
          if (theme === "dark") {
            $root.classList.remove("light");
            $root.classList.add("dark");
          } else {
            $root.classList.remove("dark");
            $root.classList.add("light");
          }
        }
      );
      this.attachShadow({ mode }).appendChild($root);
    }
    attributeChangedCallback(name, _, value) {
      switch (name) {
        case "theme": {
          const theme = value === "dark" ? "dark" : "light";
          const event = new CustomEvent("updateTheme", { detail: theme });
          this.app.dispatchEvent(event);
          break;
        }
        default: {
          const parts = name.split("-");
          const prop = `${parts[0]}${parts
            .slice(1)
            .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)}`;
          if (typeof this.app[prop] === "number") {
            this.app[prop] = Number.parseInt(value);
          }
          break;
        }
      }
    }
  }
  window.customElements.define(name, HTMLMaPaPAElement);
}

//#endregion
