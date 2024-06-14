/**
 * Magic Palette for Pixel Arts.
 * https://github.com/zhengxiaoyao0716/ma-pa-p-a
 */

/**
 * @typedef {import("./types").Rect} Rect
 * @typedef {import("./types").Palette} Palette
 * @typedef {import("./types").Archive} Archive
 */

/** Magic Palette for Pixel Arts Application */
export class App extends EventTarget {
  layer = 1;
  layerNum = 1;
  /** @type {{[code: string]: Palette | { color: number, count: number, split: Palette[] }}} */
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
      const { ctx, chunks, zoom } = this.archives[arch];
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
      drawImage(ctx, output, chunk, rect, zoom);
    },

    updateChunk: ({ arch, chunk, data, plte, trans: [output] }) => {
      this.dirtyBusy--;
      const { ctx, chunks, zoom } = this.archives[arch];
      const { rect } = chunks[chunk];
      chunks[chunk] = { rect, texture: { data, plte } };
      drawImage(ctx, output, chunk, rect, zoom);
    },

    dumpPalettes: ({ name, url }) => {
      dumpFile(name, url);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };

  //#endregion

  //#region image processing

  /** @type {"count" | "color"} */
  sortBy = "count";

  sortedPalettes() {
    /** @type {(palette: Palette) => number[]} */
    const sortKeys =
      this.sortBy === "count"
        ? ({ count, color }) => [-count, color]
        : ({ color }) => transToHsl(...parseRGBA(color));
    return Object.values(this.palettes).sort((palette1, palette2) => {
      const keys1 = sortKeys(palette1);
      const keys2 = sortKeys(palette2);
      for (let i = 0; i < keys1.length; i++) {
        const key1 = keys1[0];
        const key2 = keys2[0];
        if (key1 < key2) return -1;
        else if (key1 > key2) return 1;
      }
      return 0;
    });
  }

  /** @param {(Palette | { color: number, count: number, split: Palette[] })[]} palettes . */
  *iterPalettes(palettes) {
    for (const palette of palettes) {
      if ("code" in palette) {
        if (palette.code !== "") yield palette;
      } else {
        for (const child of palette.split) {
          if (child.code !== "") yield child;
        }
      }
    }
  }

  /** @type {{[arch: string]: Set<number> }} */ dirtyChunks = {};
  dirtyBusy = 0;
  checkBusy() {
    if (this.dirtyBusy > 0) {
      this.log("warn", "the service is busy");
      return true;
    }
    return false;
  }

  flushDirty() {
    if (this.dirtyBusy > 0) return;
    for (const [arch, chunks] of Object.entries(this.dirtyChunks)) {
      const archive = this.archives[arch];
      for (const chunk of chunks) {
        const { rect, texture } = archive.chunks[chunk];
        if (texture == null) continue;
        const visible =
          archive.zoom == null ? null : archive.zoom.visible.get(chunk);
        if (visible === undefined) continue;
        const { data, plte } = texture;
        this.dirtyBusy++;
        this.request("updateChunk", {
          arch,
          chunk,
          rect,
          visible,
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

  dirtyArchive(name, archive) {
    const chunks = (this.dirtyChunks[name] = new Set());
    for (let i = 0; i < archive.chunks.length; i++) {
      chunks.add(i);
    }
  }

  /**
   * get palette.
   *
   * @param {string} code .
   * @returns {Palette | undefined}
   */
  getPalette(code) {
    if (code.length === 8) return this.palettes[code];
    /** @type {{color: number, count: number, split: Palette[]}} */
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
        layers: [],
        disable: false,
      });
    }
    if ("code" in palette) {
      if (palette.code === "") {
        this.paletteNum++;
        palette.code = code;
        palette.count = 0;
        palette.refer = {};
        palette.layers = [];
        return palette;
      } else if (!palette.disable && palette.layers[this.layer] === undefined) {
        return palette;
      }
      palette.code = `${code}00`;
      this.palettes[code] = { color, count: palette.count, split: [palette] };
    }
    /** @type {{color: number, count: number, split: Palette[]}} */
    const parent = this.palettes[code];
    for (const palette of parent.split) {
      if (palette.code === "") continue; // removed
      if (!palette.disable && palette.layers[this.layer] === undefined) {
        return palette;
      }
    }
    this.paletteNum++;
    let count = 0;
    /** @type {Palette} */
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
        const diff = value - count;
        count = value;
        parent.count += diff;
      },
      refer: {},
      layers: [],
      disable: false,
    };
    parent.split.push(children);
    return children;
  }

  /** @param {string} code . */
  eraseColor(code) {
    if (this.dirtyBusy > 0) return;
    const opacity = this.computePalette(0x00000000);
    return this.mergeColor(opacity.code, code);
  }

  /**
   * merge palette color.
   *
   * @param {string} code .
   * @param {string} from .
   */
  mergeColor(code, from) {
    if (this.dirtyBusy > 0) return;
    if (code === from) return;
    const palette0 = this.getPalette(code);
    const palette1 = this.getPalette(from);
    palette1.code = ""; // mark as removed
    this.paletteNum--;
    palette0.count += palette1.count;

    const rgba = parseRGBA(
      palette0.disable
        ? 0x000000
        : palette0.layers[this.layer] ?? palette0.color
    );
    if (palette0 == null || palette1 == null) return;
    for (const [arch, refer1] of Object.entries(palette1.refer)) {
      const refer0 = palette0.refer[arch] ?? (palette0.refer[arch] = []);
      const chunks =
        this.dirtyChunks[arch] ?? (this.dirtyChunks[arch] = new Set());
      const archives = this.archives[arch];
      for (const { chunk, offset } of refer1) {
        const { texture } = archives.chunks[chunk];
        if (texture == null) continue;
        refer0.push({ chunk, offset });
        chunks.add(chunk);
        const { plte } = texture;
        plte.set(rgba, offset);
      }
    }
    // clean
    if (from.length === 8) {
      delete this.palettes[from];
      return;
    }
    const main = from.slice(0, 8);
    const parent = this.palettes[main];
    if (parent == null || "code" in parent) return;
    /** @type {Palette | undefined} */ let found;
    for (const palette of parent.split) {
      if (palette.code === "") continue;
      if (found === undefined) {
        found = palette;
      } else {
        // more than one
        return;
      }
    }
    if (found === undefined) {
      delete this.palettes[main];
    } else {
      this.palettes[main] = { ...found, code: main };
    }
  }

  /** @param {Palette} palette . @param {number} color . */
  _setColor(palette, color) {
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

  /**
   * toggle color.
   *
   * @param {string} code .
   * @param {boolean} disable .
   */
  toggleColor(code, disable) {
    if (this.dirtyBusy > 0) return;
    const palette = this.getPalette(code);
    if (palette == null || disable == palette.disable) return;
    palette.disable = disable;
    const color = disable
      ? 0x00000000
      : palette.layers[this.layer] ?? palette.color;
    this._setColor(palette, color);
  }
  /**
   * update color.
   *
   * @param {string} code .
   * @param {number} color .
   */
  updateColor(code, color) {
    if (this.dirtyBusy > 0) return;
    const palette = this.getPalette(code);
    if (palette == null) return;
    const dirty = color === palette.color ? undefined : color;
    if (dirty === palette.layers[this.layer] && !palette.disable) return;
    palette.disable = false;
    palette.layers[this.layer] = dirty;
    this._setColor(palette, color);
  }
  /** @param {string} code . */
  restoreColor(code) {
    if (this.dirtyBusy > 0) return;
    const palette = this.getPalette(code);
    if (palette == null) return;
    if (!palette.disable && palette.layers[this.layer] === undefined) return;
    palette.disable = false;
    palette.layers[this.layer] = undefined;
    this._setColor(palette, palette.color);
  }

  /** @param {number} layer . */
  switchLayer(layer) {
    if (this.dirtyBusy > 0) return;
    if (layer === this.layer) return;
    const old = this.layer;
    if (layer < 0) this.layer = this.layerNum;
    else if (layer > this.layerNum) this.layer = 0;
    else this.layer = layer;

    const palettes = Object.values(this.palettes);
    for (const palette of this.iterPalettes(palettes)) {
      if (palette.disable) continue;
      const dirty = palette.layers[this.layer];
      if (dirty === palette.layers[old]) continue;
      this._setColor(palette, dirty ?? palette.color);
    }
  }

  appendLayer() {
    // if (this.dirtyBusy > 0) return;
    const layer = this.layer;
    this.layer = ++this.layerNum;

    const palettes = Object.values(this.palettes);
    for (const palette of this.iterPalettes(palettes)) {
      // clone current layer dirty color.
      const dirty = palette.layers[layer];
      palette.layers[this.layer] = dirty;
    }
  }

  removeLayer() {
    if (this.dirtyBusy > 0) return;
    const layer = this.layer;
    if (this.layerNum > 1) this.layerNum--;
    if (this.layer > this.layerNum) this.layer = this.layerNum;

    const palettes = Object.values(this.palettes);
    for (const palette of this.iterPalettes(palettes)) {
      // remove current layer dirty color.
      const remove = palette.layers.splice(layer, 1);
      if (palette.disable) continue;
      const dirty = palette.layers[this.layer];
      if (remove === dirty) continue;
      this._setColor(palette, dirty ?? palette.color);
    }
  }

  /**
   * erase area.
   *
   * @param {string} name .
   * @param {Rect} area .
   */
  eraseArea(name, area) {
    // TODO
  }

  /**
   * split area.
   *
   * @param {string} name .
   * @param {Rect} area .
   */
  splitArea(name, area) {
    // TODO
  }

  /**
   * zoom image.
   *
   * @param {string} name .
   * @param {Rect} area .
   */
  zoomImage(name, area) {
    if (this.dirtyBusy > 0) return;

    const archive = this.archives[name];
    const trans =
      archive.zoom == null ? [0, 0, ...archive.size] : archive.zoom.rect;
    const unit = calcUnitRect(archive, area);
    const rect = transformRect(fixRatioRect(unit), trans);

    if (!archive.ctx.canvas.classList.contains("zoom")) {
      archive.ctx.canvas.classList.add("zoom");
    } else if (rect[2] < 128) {
      // max scale, restore zoom
      archive.ctx.canvas.classList.remove("zoom");
      archive.ctx.canvas.width = archive.size[0];
      archive.ctx.canvas.height = archive.size[1];
      archive.zoom = undefined;
      this.dirtyArchive(name, archive);
      return;
    }
    if (archive.zoom == null) {
      archive.zoom = { rect: rect, visible: new Map() };
    } else {
      archive.zoom.rect = rect;
    }
    const { visible } = archive.zoom;
    visible.clear();
    const chunks = intersectChunks(archive.chunks, rect);
    for (const [index, intersect] of chunks) {
      visible.set(index, intersect);
    }
    archive.ctx.canvas.width = rect[2];
    archive.ctx.canvas.height = rect[3];
    this.dirtyArchive(name, archive);
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
    const archive = {
      ctx: canvas.getContext("2d", { willReadFrequently: true }),
      size: [64, 64],
      chunks: [],
    };
    this.archiveNum++;
    this.archives[name] = archive;
    this.dispatchEvent(new CustomEvent("createImage", { detail: archive }));

    bitmap.then((bitmap) => {
      archive.size[0] = bitmap.width;
      archive.size[1] = bitmap.height;
      const { canvas } = archive.ctx;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      archive.ctx.strokeStyle = "#808080";
      archive.ctx.strokeRect(0, 0, bitmap.width, bitmap.height);
      canvas.classList.remove("loading");

      const arch = canvas.title;
      for (const rect of chunkRects(
        bitmap.width,
        bitmap.height,
        this.chunkSize
      )) {
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
    this.layer = 1;
    this.layerNum = 1;
    this.palettes = {};
    this.paletteNum = 0;
    this.archives = {};
    this.archiveNum = 0;
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
   * @param {...object} [varargs] .
   */
  log(level, message, ...varargs) {
    console[level](`[ma-pa-p-a] ${message}`, ...varargs);
    this.dispatchEvent(new CustomEvent("log", { detail: { level, message } }));
  }

  dump() {
    const palettes = Array.from(this.iterPalettes(this.sortedPalettes()));
    const origin = palettes.map(({ color }) => parseRGBA(color));
    const colors = palettes.flatMap(({ layers: [dirty] }, i) =>
      dirty == null ? origin[i] : parseRGBA(dirty)
    );
    const rowSize = colors.length;
    let length = rowSize;
    for (let j = 1; j <= this.layerNum; j++) {
      let regress = true;
      for (let i = 0; i < palettes.length; i++) {
        const dirty = palettes[i].layers[j];
        if (dirty === undefined) {
          const color = origin[i];
          for (const value of color) {
            colors[length++] = value;
          }
        } else {
          regress = false;
          for (const value of parseRGBA(dirty)) {
            colors[length++] = value;
          }
        }
      }
      if (regress) length -= rowSize;
    }
    const plte = new Uint8ClampedArray(colors.slice(0, length));
    const width = palettes.length;
    const height = plte.length / width / 4;
    const salt = (new Date().getTime() & 0xffffff)
      .toString(16)
      .padStart(6, "0");
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
      if (
        !(
          event.target instanceof HTMLAnchorElement ||
          event.target instanceof HTMLButtonElement
        )
      ) {
        return;
      }
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
   * @param {{[id: string]: string | () => string}} items .
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
   * @param {{[id: string]: string | () => string}} items .
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
   * @param {[name: string, label: string | () => string]} item .
   * @returns {string} html
   */
  menuItem([id, fn]) {
    const label = fn instanceof Function ? fn() : fn;
    if (!label) return "";
    const hotkey =
      id in Dialog.hotkeys ? `<small>${Dialog.hotkeys[id]}</small>` : "";
    return `<a id="${id}" href="javascript:void(0);"><span>${label}</span>${hotkey}</a>`;
  }

  static hotkeys = {
    ctrl: "⌃ Ctrl + Click",
    shift: "⇧ Shift + Click",
    alt: "⌥ Alt + Click",
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
/** @param {number} r . @param {number} g . @param {number} b . @param {number} a . */
function transToHsl(r, g, b, a) {
  r /= 255;
  g /= 255;
  b /= 255;
  const alpha = (100 * a) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;
  const lightness = 50 * (max + min);
  if (diff === 0) return [0, 0, lightness, alpha];
  const saturation =
    100 * (lightness > 50 ? diff / (2 - max - min) : diff / (max + min));
  const hue =
    max === r
      ? (60 * (g - b)) / diff + (g < b ? 360 : 0)
      : max === g
      ? (60 * (b - r)) / diff + 120
      : /* max === b */
        (60 * (r - g)) / diff + 240;
  return [hue, saturation, lightness, alpha];
}

//#region area processing

/** @returns {Rect} */
function intersectBound(l0, t0, r0, b0, l1, t1, r1, b1) {
  const left = l0 < l1 ? l1 : l0;
  const right = r0 < r1 ? r0 : r1;
  if (left > right) return null;
  const top = t0 < t1 ? t1 : t0;
  const bottom = b0 < b1 ? b0 : b1;
  if (top > bottom) return null;
  return [left, top, right - left, bottom - top];
}
/**
 * iter intersect chunks.
 *
 * @param {Archive["chunks"]} chunks .
 * @param {Rect} rect .
 * @returns {Iterable<[number, Rect, Archive["chunks"][number]]>}
 */
function* intersectChunks(chunks, [left, top, width, height]) {
  const right = left + width;
  const bottom = top + height;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const intersect = intersectBound(
      left,
      top,
      right,
      bottom,
      chunk.rect[0],
      chunk.rect[1],
      chunk.rect[0] + chunk.rect[2],
      chunk.rect[1] + chunk.rect[3]
    );
    if (intersect) yield [index, intersect, chunk];
  }
}

/**
 * calc archive rect.
 *
 * @param {Archive} archive .
 * @param {Rect} area .
 * @returns {Rect} .
 */
function calcUnitRect(archive, area) {
  const { offsetLeft, offsetTop, offsetWidth, offsetHeight } =
    archive.ctx.canvas;
  let x = (area[0] - offsetLeft) / offsetWidth;
  let y = (area[1] - offsetTop) / offsetHeight;
  let w = area[2] / offsetWidth;
  let h = area[3] / offsetHeight;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  const wm = 1 - x;
  const hm = 1 - y;
  if (w > wm) w = wm;
  if (h > hm) h = hm;
  return [x, y, w, h];
}

/**
 * keep rect ratio.
 *
 * @param {Rect} rect .
 * @returns {Rect} .
 */
function fixRatioRect(rect) {
  let [x, y, w, h] = rect;
  if (w < h) {
    const min = 1 - h;
    if (min < x) {
      x = min;
    } else {
      x += (w - h) / 2;
      if (x < 0) x = 0;
    }
    return [x, y, h, h];
  } else if (w > h) {
    const min = 1 - w;
    if (min < y) {
      y = min;
    } else {
      y += (h - w) / 2;
      if (y < 0) y = 0;
    }
    return [x, y, w, w];
  } else {
    return rect;
  }
}

/**
 * transform rect.
 *
 * @param {Rect} rect .
 * @param {Rect} transformer .
 * @returns {Rect} .
 */
function transformRect([x, y, w, h], [moveX, moveY, scaleW, scaleH]) {
  return [
    Math.round(moveX + x * scaleW),
    Math.round(moveY + y * scaleH),
    Math.round(w * scaleW),
    Math.round(h * scaleH),
  ];
}

/**
 * draw image.
 *
 * @param {CanvasRenderingContext2D} ctx .
 * @param {ImageBitmap} output .
 * @param {number} index .
 * @param {Rect} rect .
 * @param {Archive["zoom"]} zoom .
 */
function drawImage(ctx, output, index, [x, y, w, h], zoom) {
  if (zoom == null) {
    ctx.clearRect(x, y, w, h);
    ctx.drawImage(output, x, y, w, h);
    output.close();
    return;
  }
  const intersect = zoom.visible.get(index);
  if (intersect == null) {
    output.close();
    return;
  }
  const [sx, sy, sw, sh] = intersect;
  const dx = sx - zoom.rect[0];
  const dy = sy - zoom.rect[1];
  const dw = sw;
  const dh = sh;
  ctx.clearRect(dx, dy, dw, dh);
  ctx.drawImage(output, dx, dy, dw, dh);
  output.close();
}

//#endregion

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
 * @param {number} width .
 * @param {number} height .
 * @param {number} chunkSize .
 * @returns {Iterable<Rect>} chunk rects
 */
function* chunkRects(width, height, chunkSize) {
  if (width > height) {
    const chunks = chunkRects(height, width, chunkSize);
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
    if (isFile) {
      event.dataTransfer.dropEffect = "copy";
      event.currentTarget.classList.add("dragover");
    } else {
      event.dataTransfer.dropEffect = "none";
    }
  });
  $root.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const isFile = event.dataTransfer.types.some((type) => type === "Files");
    event.dataTransfer.dropEffect = isFile ? "copy" : "none";
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
 * @param {number} layer .
 * @param {number} index .
 * @param {Palette} palette .
 * @returns {HTMLAnchorElement} .
 */
function paletteColor(layer, index, { code, color, count, layers, disable }) {
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
  const dirty = layers[layer];
  const rgba = dirty || color;
  if ((rgba & 0xff) < 0xff) {
    $color.classList.add("tp-grid");
  }
  const hex = `#${rgba.toString(16).padStart(8, "0")}`;
  $color.style.setProperty("--color", hex);
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
  $colors.draggable = true;
  $colors.addEventListener("dragstart", (event) => {
    if (!(event.target instanceof HTMLAnchorElement)) return;
    const code = event.target.id.slice(5);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", code);
    event.currentTarget.setAttribute("merge-color", code);
  });
  $colors.addEventListener("drop", (event) => {
    if (!(event.target instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const code = event.target.id.slice(5);
    const from = event.dataTransfer.getData("text/plain");
    event.currentTarget.removeAttribute("merge-color", code);
    if (app.checkBusy()) return;
    app.mergeColor(code, from);
    app.flushDirty();
    app.log("info", `merged ${code} into ${from}`);
  });
  /** @param {DragEvent} event . */
  function dragover(event) {
    if (!(event.target instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  }
  $colors.addEventListener("dragover", dragover);
  $colors.addEventListener("dragenter", dragover);
  $colors.addEventListener("dragend", (event) => {
    if (!(event.target instanceof HTMLAnchorElement)) return;
    event.currentTarget.removeAttribute("merge-color");
  });

  app.addEventListener("clear", () => {
    $upload.classList.remove("hide");
    $colors.innerHTML = "";
    $colors.classList.add("hide");
  });
  app.addEventListener(
    "updatePalette",
    /** @param {CustomEvent<Iterable<Palette>>} event . */ ({
      currentTarget,
      detail: palettes,
    }) => {
      const { layer } = currentTarget;
      $colors.innerHTML = "";
      let i = 0;
      for (const palette of palettes) {
        const $color = paletteColor(layer, ++i, palette);
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
    {
      ctrl: "Focus",
      shift: "Toggle",
      alt: "Exclude",
      erase: "Erase",
      merge: () =>
        $colors.hasAttribute("merge-color")
          ? "Merge selected"
          : "Merge to other",
    },
    ({ target: $color }) => {
      if (!($color instanceof HTMLAnchorElement)) return;
      const code = $color.id.slice(5);
      const raw = `#${code.slice(0, 8).toLowerCase()}`;
      const hex = $color.style.getPropertyValue("--color");
      const color = Number.parseInt(hex.slice(1), 16);
      const [r, g, b, a] = parseRGBA(color);
      const [h, s, l, alpha] = transToHsl(r, g, b, a).map(Math.round);

      const mergeFrom = $colors.getAttribute("merge-color");
      if (mergeFrom && mergeFrom === code) {
        $colors.removeAttribute("merge-color");
      }

      const html = () => `<div class="titlebar header hr">
        <a${raw === hex ? "" : ' id="restore"'} title="Restore"
          class="color tp-grid" href="javascript:void(0);" style="--color: ${raw};"
        ></a>
        <label>
          <span>${$color.title}</span>
          <small>rgb(${r} ${g} ${b} / ${a})</small>
          <small>hsl(${h}deg ${s}% ${l}% / ${alpha}%)</small>
        </label>
      </div>
      <div id="colorPicker">
        <label id="rgb">
          <input type="color" value="${hex.slice(0, 7)}" />
          <pre>${hex.slice(0, 7)}</pre>
        </label>
        <label id="alpha">
          <input type="range" min="0" max="255" value="${a}" />
          <pre>A: ${a}</pre>
        </label>
      </div>
      <a id="submit" class="footer fold" href="javascript:void(0);">Submit</a>`;

      /** @param {HTMLDivElement} $dialog . */
      const show = ($dialog) => {
        const $rgb = $dialog.querySelector("label#rgb>input");
        const $alpha = $dialog.querySelector("label#alpha>input");
        const $submit = $dialog.querySelector("#submit");
        let dirty = color;
        const onInput = () => {
          const rgb = Number.parseInt($rgb.value.slice(1), 16);
          const alpha = Number.parseInt($alpha.value);
          dirty = rgb * 256 + alpha;
          if (dirty !== color) $submit.classList.remove("fold");
        };
        $rgb.addEventListener("input", (event) => {
          const value = event.currentTarget.value;
          $dialog.querySelector("label#rgb>pre").innerHTML = value;
          onInput();
        });
        $alpha.addEventListener("input", (event) => {
          const value = event.currentTarget.value;
          const text = `A: ${value.padStart(3, " ")}`;
          $dialog.querySelector("label#alpha>pre").innerHTML = text;
          onInput();
        });
        $submit.addEventListener("click", () => {
          if (app.checkBusy()) return;
          app.dialog.hide();
          app.updateColor(code, dirty);
          app.flushDirty();
          const hex = `#${dirty.toString(16)}`;
          app.log("info", `color updated, code: ${code}, color: ${hex}`);
        });
      };

      const toggle = () => {
        if (app.checkBusy()) return;
        const disable = !$color.classList.contains("cross-out");
        app.toggleColor(code, disable);
        app.flushDirty();
        app.log("info", `color ${disable ? "disabled" : "enabled "}: ${code}`);
      };
      const highlight = (focus) => {
        if (app.checkBusy()) return;
        for (const $color of $colors.children) {
          if (!($color instanceof HTMLAnchorElement)) continue;
          if (!$color.id.startsWith("color")) continue;
          const code = $color.id.slice(5);
          const hex = $color.style.getPropertyValue("--color");
          const color = Number.parseInt(hex.slice(1), 16);
          app.toggleColor(code, focus);
        }
        app.toggleColor(code, !focus);
        app.flushDirty();
        app.log("info", `color ${focus ? "focused " : "excluded"}: ${code}`);
      };
      const restore = () => {
        if (app.checkBusy()) return;
        app.restoreColor(code);
        app.flushDirty();
        app.log("info", `color restored: ${code}`);
      };
      return {
        html,
        show,
        actions: {
          ctrl: () => highlight(true),
          shift: toggle,
          alt: () => highlight(false),
          restore,
          erase: () => {
            if (app.checkBusy()) return;
            app.eraseColor(code);
            app.flushDirty();
            app.log("info", `erased color ${code}`);
          },
          merge: () => {
            const from = $color.parentElement.getAttribute("merge-color");
            if (from == null) {
              $color.parentElement.setAttribute("merge-color", code);
              const svg =
                '<svg xmlns="http://www.w3.org/2000/svg" width="16px" height="16px" viewBox="0 0 24 24">' +
                `<g fill="${hex}" stroke="#808080" stroke-width="4"><rect x="0" y="0" width="24" height="24" /></g></svg>`;
              const uri = `url('data:image/svg+xml,${encodeURIComponent(
                svg
              )}')`;
              $color.parentElement.style.setProperty("--cursor", uri);
            } else {
              $color.parentElement.removeAttribute("merge-color");
              if (app.checkBusy()) return;
              app.mergeColor(code, from);
              app.flushDirty();
              app.log("info", `merged color ${code} into ${from}`);
            }
          },
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
      // sort: () =>
      //   app.sortBy === "count" ? "Sort by rainbow" : "Sort by pixel count",
      clear: "Clear all",
    },
    () => {
      const html = () => `<label class="header">
        <span title="Prev:   ⌥ Alt + Click\nNext: ⇧ Shift + Click">
          <span>Layer:</span>
          <input id="layer" type="number" min="0"
            max="${app.layerNum}" value="${app.layer}">
          <span>/</span>
          <span class="titlebar layer-num">
            <button id="remove" title="Remove layer">-</button>
            <span>${app.layerNum}</span>
            <button id="append" title="Append layer">+</button>
          </span>
        </span>
        <small>${app.paletteNum} color in ${app.archiveNum} archive</small>
      </label><a id="submit" class="footer fold">Switch layer</a>`;

      const switchLayer = (layer) => {
        if (app.checkBusy()) return;
        app.switchLayer(layer);
        app.flushDirty();
        app.log("info", `switch to layer ${app.layer}`);
      };
      /** @param {HTMLDivElement} $dialog . */
      const show = ($dialog) => {
        const $input = $dialog.querySelector("input#layer");
        const $submit = $dialog.querySelector("#submit");
        let layer = app.layer;
        $input.addEventListener("input", ({ currentTarget }) => {
          layer = Number.parseInt(currentTarget.value.trim() || "0");
          if (layer < 0 || layer > app.layerNum) {
            layer = app.layer;
          } else if (layer !== app.layer) {
            $submit.classList.remove("fold");
          }
        });
        $submit.addEventListener("click", () => {
          app.dialog.hide();
          switchLayer(layer);
        });
      };
      return {
        html,
        show,
        actions: {
          ctrl: () => app.dump().exportAll(),
          palettes: () => app.dump().palettes(),
          archives: () => app.dump().archives(),
          shift: () => switchLayer(app.layer + 1),
          alt: () => switchLayer(app.layer - 1),
          append: () => {
            // if (app.checkBusy()) return;
            app.appendLayer();
            // app.flushDirty();
            app.log("info", `append layer at ${app.layer}`);
          },
          remove: () => {
            if (app.checkBusy()) return;
            app.removeLayer();
            app.flushDirty();
            app.log("info", `remove layer at ${app.layer}`);
          },
          clear: () => app.clearAll(),
          sort: () => {
            app.sortBy = app.sortBy === "count" ? "color" : "count";
            app.flushDirty();
          },
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
    get name() {
      return $selectArea.title;
    },
    set name(value) {
      $selectArea.title = value;
      if (value !== "") app.log("info", `focus on ${value}`);
    },
    posX: 0,
    posY: 0,
    type: "",
    time: 0,
    /** @type {Rect | null} */
    area: null,
  };
  /** @param {MouseEvent | TouchEvent} event . */
  function drawArea(event, create = false) {
    if (!event.cancelable) {
      // scrolling
      $selectArea.classList.remove("show");
      selection.name = "";
      return null;
    }
    const $images = event.currentTarget;
    if (!($images instanceof HTMLDivElement)) return null;
    const mouse = event instanceof TouchEvent ? event.touches[0] : event;
    if (mouse == null) return selection.area;
    const { left, top } = $images.getBoundingClientRect();
    const mouseX = mouse.clientX - left;
    const mouseY = mouse.clientY - top;
    const { scrollTop } = $images.parentElement;

    const $canvas = event.target;
    let init = create;
    if ($canvas instanceof HTMLCanvasElement) {
      if (selection.name === $canvas.title) {
        init = false;
      } else if (selection.name === "") {
        if (init) {
          init = selection.area == null;
          selection.name = $canvas.title;
          $canvas.focus();
        } else if (selection.area == null) {
          return;
        } else {
          selection.name = $canvas.title;
          $canvas.focus();
        }
      } else if (init) {
        return selection.area;
        // selection.name = $canvas.title;
        // $canvas.focus();
        // selection.area = null;
      }
    } else {
      if (selection.name === "") {
        if (!init && selection.area == null) return;
        selection.area = [0, 0, 0, 0];
      } else {
        init = false;
      }
    }
    if (init) {
      selection.posX = mouseX;
      selection.posY = mouseY + scrollTop;
      if (event.ctrlKey) selection.type = "zoom";
      else if (event.shiftKey) selection.type = "split";
      else if (event.altKey) selection.type = "erase";
      selection.time = performance.now();
      $selectArea.style.left = `${mouseX}px`;
      $selectArea.style.top = `${mouseY}px`;
      $selectArea.style.width = `0px`;
      $selectArea.style.height = `0px`;
      $selectArea.classList.add("show");
      return selection.area;
    }
    if (event instanceof TouchEvent && event.touches.length >= 2) {
      event.preventDefault();
      event.stopPropagation();
      const { clientX, clientY } = event.touches[event.touches.length - 1];
      selection.posX = clientX - left;
      selection.posY = clientY - top + scrollTop;
    }
    const posX = selection.posX;
    const posY = selection.posY - scrollTop;
    const [x, endX] = mouseX < posX ? [mouseX, posX] : [posX, mouseX];
    const [y, endY] = mouseY < posY ? [mouseY, posY] : [posY, mouseY];
    const w = endX - x;
    const h = endY - y;
    $selectArea.style.left = `${x}px`;
    $selectArea.style.top = `${y}px`;
    $selectArea.style.width = `${w}px`;
    $selectArea.style.height = `${h}px`;
    return (selection.area = [x, y, w, h]);
  }
  $images.addEventListener("mousemove", drawArea);
  $images.addEventListener("mouseout", drawArea);

  /**
   * submit area.
   *
   * @param {string} arch .
   * @param {string} type .
   * @param {Rect} area .
   */
  function submitArea(arch, type, area) {
    $selectArea.classList.remove("show");
    selection.name = selection.type = "";
    selection.area = null;
    if (app.checkBusy()) return;
    switch (type) {
      case "zoom":
        app.zoomImage(arch, area);
        break;
      case "split":
        app.splitArea(arch, area);
        break;
      case "erase":
        app.eraseArea(arch, area);
        break;
      default:
        return;
    }
    app.flushDirty();
    app.log("info", `${type} ${arch}`);
  }
  const menuItems = {
    ctrl: "Zoom area",
    shift: "Split area",
    alt: "Erase area",
  };
  /** @param {MouseEvent | TouchEvent} event . */
  const menuHandler = (event) => {
    const pass = performance.now() - selection.time;
    const area = pass < 300 ? null : drawArea(event);
    const arch =
      selection.name === "" && event.target instanceof HTMLCanvasElement
        ? event.target.title
        : selection.name;

    const html = () => {
      if (arch === "") {
        return `<label class="header hr"><span>Select editor action</span></label>`;
      }
      const { size, chunks } = app.archives[arch];
      return `<label class="header hr">
      <span>${arch}</span>
      <small>${size.join("x")} with ${chunks.length} chunk</small>
    </label>`;
    };

    /** @param {string} type . */
    function selectType(type) {
      if (arch === "" || area == null) selection.type = type;
      else submitArea(arch, type, area);
    }
    return {
      html,
      show: () => {
        // $selectArea.classList.remove("show");
        selection.name = selection.type = "";
        selection.area = null;
      },
      actions: {
        ctrl: () => selectType("zoom"),
        shift: () => selectType("split"),
        alt: () => selectType("erase"),
        click: () => {
          if (area == null) return;
          const { name, type } = selection;
          if (type) {
            submitArea(name, type, area);
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
      const { left, top } = event.currentTarget.getBoundingClientRect();
      const { scrollTop } = event.currentTarget.parentElement;
      const { clientX, clientY } =
        event.changedTouches[event.changedTouches.length - 1];
      selection.posX = clientX - left;
      selection.posY = clientY - top + scrollTop;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const content = menuHandler(event);
    if (content == null) return;
    const { ctrl, shift, alt, click } = content.actions;
    if (event.ctrlKey) ctrl();
    else if (event.shiftKey) shift();
    else if (event.altKey) alt();
    else if (click()) app.dialog.show(menuItems, content);
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
