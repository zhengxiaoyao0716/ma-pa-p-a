/**
 * Magic Palette for Pixel Arts.
 * https://github.com/zhengxiaoyao0716/ma-pa-p-a
 */

const TAG = "[ma-pa-p-a]";

/**
 * @typedef {import("./types").Palette} Palette
 * @typedef {import("./types").Archive} Archive
 */

/** Magic Palette for Pixel Arts Application */
export class App extends EventTarget {
  /** @type {{[code: string]: Palette}} */
  palettes = {};
  /** @type {{[name: string]: Archive}} */
  archives = {};

  constructor({
    imageLimit = 16, // 16MB
    chunkSize = 1 << 18, // 512 * 512
    workersNum = 8,
  } = {}) {
    super();
    this.imageLimit = imageLimit;
    this.chunkSize = chunkSize;
    this.workersNum = workersNum;
  }

  //#region worker pools

  /** @type {WorkerService[]} */ workers = [];

  //

  get workersNum() {
    return this.workers.length;
  }
  set workersNum(num) {
    WorkerService.resize(this.workers, num, this.handlers);
  }

  /** @type {import("./types").MsgRequest} */
  request = (type, body) => {
    const worker = WorkerService.idle(this.workers);
    worker.postMessage({ type, body }, body.trans);
  };

  /** @type {import("./types").MsgHandlers} */
  handlers = {
    parseGzip: ({ name, buffer }) => {
      // TODO
      console.log("TODO on parsed gzip", name, buffer);
    },

    parseImage: ({ arch, chunk, data, plte, trans: [output, count] }) => {
      const colorNum = plte.byteLength >> 2;
      if (colorNum > 256) {
        console.error(
          `${TAG} too many colors, name: ${arch}, limit: ${256}, count: ${colorNum}+`
        );
        return;
      }
      const { canvas, chunks } = this.archives[arch];
      const { rect } = chunks[chunk];
      chunks[chunk] = { rect, texture: { data, plte } };

      const colors = new DataView(plte.buffer);
      const counter = new DataView(count);
      for (let i = 0; i < colors.byteLength; i += 4) {
        const color = colors.getUint32(i);
        const count = counter.getUint32(i, true);
        const code = color.toString(16).toUpperCase();
        const palette =
          this.palettes[code] ??
          (this.palettes[code] = {
            color,
            count: 0,
            refer: {},
          });
        palette.count += count;
        const refer = palette.refer[arch] ?? (palette.refer[arch] = []);
        refer.push({ chunk, offset: i });
      }
      this.dispatchEvent(
        new CustomEvent("updatePalette", { detail: this.palettes })
      );
      const ctx = canvas.getContext("2d");
      ctx.drawImage(output, ...rect);
    },

    updateChunk: ({ arch, chunk, data, plte, trans: [output] }) => {
      const { canvas, chunks } = this.archives[arch];
      const { rect } = chunks[chunk];
      chunks[chunk] = { rect, texture: { data, plte } };
      const ctx = canvas.getContext("2d");
      ctx.clearRect(...rect);
      ctx.drawImage(output, ...rect);
    },
  };

  //#endregion

  //#region palette operate

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
  }

  /**
   * toggle color disable status.
   *
   * @param {string} code .
   * @param {number} color .
   */
  replaceColor(code, color) {
    const palette = this.palettes[code];
    if (palette == null) return;
    for (const [arch, refer] of Object.entries(palette.refer)) {
      const chunks =
        this.dirtyChunks[arch] ?? (this.dirtyChunks[arch] = new Set());
      const archives = this.archives[arch];
      for (const { chunk, offset } of refer) {
        const { texture } = archives.chunks[chunk];
        if (texture == null) continue;
        chunks.add(chunk);
        const { plte } = texture;
        plte.set(parseRGBA(color), offset);
      }
    }
  }

  /**
   * toggle color disable status.
   *
   * @param {string} code .
   * @param {boolean} disable .
   */
  disableColor(code, disable) {
    const palette = this.palettes[code];
    if (palette == null) return;
    this.replaceColor(code, disable ? 0x00000000 : palette.color);
  }

  //#endregion

  /**
   * render image
   * @param {Archive} archive .
   * @param {HTMLImageElement} $image .
   */
  parseImageData({ canvas, chunks }, $image) {
    canvas.width = $image.width;
    canvas.height = $image.height;
    const arch = canvas.title;
    for (const rect of chunkRects($image, this.chunkSize)) {
      const id = chunks.length;
      chunks.push({ rect });
      window.createImageBitmap($image, ...rect).then((source) => {
        this.request("parseImage", {
          arch,
          chunk: id,
          trans: [source],
        });
      });
    }
  }

  /**
   * parse image blob.
   *
   * @param {string} name .
   * @param {Blob} blob .
   */
  parseImageBlob(name, blob) {
    if (name in this.archives) {
      console.warn(`${TAG} duplicated image, name: ${name}`);
      return;
    }
    /** @type {Archive} */ const archive = {
      canvas: document.createElement("canvas"),
      chunks: [],
    };
    archive.canvas.title = name;
    archive.canvas.classList.add("loading");

    const $image = new Image();
    $image.addEventListener("load", (event) => {
      this.parseImageData(archive, event.currentTarget);
      archive.canvas.classList.remove("loading");
      URL.revokeObjectURL($image.src);
    });
    $image.src = URL.createObjectURL(blob);

    this.archives[name] = archive;
    this.dispatchEvent(new CustomEvent("createImage", { detail: archive }));
  }

  /**
   * parse blob.
   *
   * @param {string} path .
   * @param {Blob} blob .
   */
  parseBlob(path, blob) {
    if (blob.size > this.imageLimit << 20) {
      const size = (blob.size / 1024).toFixed(2);
      console.error(
        `${TAG} file too large, size: ${size}KB, max: ${this.imageLimit}MB`
      );
      return;
    }
    const index = path.lastIndexOf(".");
    const name = path.slice(0, index);
    switch (path.slice(1 + index)) {
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
        console.warn(`${TAG} unknown type, name: ${name}`);
        break;
      }
    }
  }

  clearCache() {
    this.palettes = {};
    this.archives = {};
    this.dispatchEvent(new CustomEvent("clear"));
  }

  /** @param {FileList} sources . */
  handleUpload = (sources) => {
    // this.clearCache();
    for (const source of sources) {
      this.parseBlob(source.name, source);
    }
    this.dispatchEvent(new CustomEvent("uploaded", { detail: sources }));
  };
}

//

class WorkerService {
  /**
   * resize worker services.
   *
   * @param {WorkerService[]} services .
   * @param {number} num .
   * @param {import("./types").MsgHandlers} handlers .
   */
  static resize(services, num, handlers) {
    const { length } = services;
    if (num <= length) {
      for (let i = num; i < length; i++) {
        const service = services.pop();
        service._safelyTerminate();
      }
      return;
    }
    for (let i = length; i < num; i++) {
      const service = new WorkerService();
      service._handle(handlers);
      services.push(service);
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

  /** @param {import("./types").MsgHandlers} handlers . */
  _handle(handlers) {
    this.worker.addEventListener(
      "message",
      /** @param {MessageEvent<{type: import("./types").MsgType, resp?: {}, error?: object}>} event . */
      ({ data: { type, resp, error } }) => {
        this._taskCount--;
        if (error) {
          console.error(`${TAG} worker request failed, type: ${type}`, error);
        } else {
          handlers[type](resp);
        }
      }
    );
  }

  _safelyTerminate() {
    if (this._taskCount <= 0) {
      this.worker.terminate();
      console.debug(`${TAG} worker terminated, id: ${this.id}`);
      return;
    }
    this.worker.addEventListener("message", () => {
      setTimeout(() => {
        if (this._taskCount > 0) return;
        this.worker.terminate();
        console.debug(`${TAG} worker safely exited, id: ${this.id}`);
      }, 0);
    });
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
 * export file.
 *
 * @param {Blob} blob .
 * @param {string} name .
 */
function exportFile(blob, name) {
  const $save = document.createElement("a");
  $save.href = URL.createObjectURL(blob);
  $save.download = name;
  $save.click();
  setTimeout(() => URL.revokeObjectURL($save.href), 0);
}

/**
 * export image.
 *
 * @param {HTMLCanvasElement} canvas .
 * @param {string} name .
 * @param {"png" | "webp"} [format="webp"]
 */
function exportImage(canvas, name, format = "webp") {
  canvas.toBlob(
    (blob) => exportFile(blob, `${name}.${format}`),
    `image/${format}`,
    1.0
  );
}

/**
 * iter chunks.
 *
 * @param {{width: number, height: number}} imageSize .
 * @param {number} chunkSize .
 * @returns {Iterable<[x: number, y: number, w: number, h: number]>} chunk rects
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
 * @param {HTMLElement} $target .
 * @param {(files: FileList) => void} upload .
 */
function listenUpload($target, upload) {
  $target.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.add("dragover");
  });
  $target.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  $target.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove("dragover");
  });
  $target.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove("dragover");
    upload(event.dataTransfer.files);
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
    console.debug(`${TAG} auto fetch and parse, url: ${url}`);
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
 * @param {string} code .
 * @param {Palette} palette .
 * @returns {HTMLAnchorElement} .
 */
function paletteColor(index, code, { color, count }) {
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
  if ((color & 0xff) < 0xff) {
    $color.classList.add("tp-grid");
  }
  const hex = `#${color.toString(16).padStart(8, "0")}`;
  $color.style.setProperty("--color", hex);
  $color.href = "javascript:void(0);";
  return $color;
}

//#endregion

//#region layout

/**
 * create titlebar.
 *
 * @param {App} app .
 * @returns titlebar element
 */
function createTitlebar(app) {
  const $clear = document.createElement("a");
  $clear.id = "clear";
  $clear.href = "javascript:void(0);";
  $clear.title = "clear all";
  $clear.innerText = "🔄️";
  $clear.addEventListener("click", app.clearCache.bind(app));

  const $input = document.createElement("input");
  $input.type = "file";
  $input.multiple = true;
  $input.addEventListener("input", (event) => {
    const { files } = event.currentTarget;
    app.handleUpload(files);
  });
  app.addEventListener("clear", () => {
    $input.files = null;
    $input.value = "";
  });
  app.addEventListener("uploaded", (event) => {
    $input.files = event.detail;
  });

  const $controller = document.createElement("div");
  $controller.classList.add("controller");
  $controller.appendChild($clear);
  $controller.appendChild($input);

  const $label = document.createElement("label");
  $label.id = "titlebar";
  $label.innerHTML = '<span class="drag-tips">Drag the image here.</span>';
  $label.appendChild($controller);
  listenUpload($label, app.handleUpload);
  return $label;
}

/**
 * create palette.
 *
 * @param {App} app .
 * @returns palette element
 */
function createPalette(app) {
  const $panel = document.createElement("div");
  $panel.id = "palette";
  $panel.innerHTML =
    '<a id="color#00000000" href="javascript:void(0);" class="tp-grid"><span/></a>';
  app.addEventListener("clear", () => {
    $panel.innerHTML =
      '<a id="color#00000000" href="javascript:void(0);" class="tp-grid"><span/></a>';
  });
  app.addEventListener(
    "updatePalette",
    /** @param {CustomEvent<{[code: string]: Palette}>} event . */ ({
      detail: palettes,
    }) => {
      $panel.innerHTML = "";
      const colors = Object.entries(palettes);
      colors.sort(([_o1, { count: c1 }], [_o2, { count: c2 }]) =>
        c1 < c2 ? 1 : c1 > c2 ? -1 : 0
      );
      for (let index = 0; index < colors.length; index++) {
        const [code, palette] = colors[index];
        const $color = paletteColor(index, code, palette);
        $panel.appendChild($color);
      }
    }
  );
  $panel.addEventListener("click", ({ target: $color }) => {
    if (!($color instanceof HTMLAnchorElement)) return;
    if (!$color.id.startsWith("color")) return;
    const code = $color.id.slice(5);
    // const hex = $color.style.getPropertyValue("--color");
    // const color = Number.parseInt(hex.slice(1), 16);

    // TODO toggle disable
    const disable = !$color.classList.contains("cross-out");
    app.disableColor(code, disable);
    app.flushDirty();
    if (disable) $color.classList.add("cross-out");
    else $color.classList.remove("cross-out");
  });
  listenUpload($panel, app.handleUpload); // 防呆设计
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
  app.addEventListener("clear", () => {
    $images.innerHTML = "";
  });
  app.addEventListener(
    "createImage",
    /** @param {CustomEvent<Archive>} event . */ ({ detail: { canvas } }) => {
      $images.appendChild(canvas);
    }
  );

  const $panel = document.createElement("div");
  $panel.id = "archives";
  $panel.classList.add("tp-grid");
  $panel.appendChild($images);
  listenUpload($panel, app.handleUpload); // 防呆设计
  return $panel;
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
 */
export function render(app, root = ".mppa", query = "fetch") {
  const $root =
    root instanceof HTMLElement ? root : document.querySelector(root);
  $root.appendChild(createTitlebar(app));
  $root.appendChild(createPalette(app));
  $root.appendChild(createArchives(app));
  if (query) fetchAndParse(app, query);
}

//

/* Inject Style */

//

/**
 * create root.
 *
 * @param {App} app .
 * @param {{id?: string, theme?: "light" | "dark"}} [props={}] .
 * @returns root element
 */
export function inject(app, { scope = "mppa", theme = "light" } = {}) {
  const $root = document.createElement("div");
  $root.classList.add(scope, theme);
  $root.appendChild(createStyle(scope));
  render(app, $root);
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
      const $root = inject(this.app, { scope, theme });
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

// log package info.
setTimeout(async () => {
  const pkg = await fetch(new URL("./package.json", import.meta.url)).then(
    (resp) => resp.json()
  );
  const label = `${pkg.name} v${pkg.version}`;
  const pkgInfo = [
    `%c${label}%c`,
    `%c${pkg.author}%c`,
    "\n",
    `%c${pkg.license}%c`,
    `%c${pkg.homepage}%c`,
    "\n",
  ].join("");

  const padding = "padding: 0.2em 0.5em;";
  const style = [
    ...[`background: #6cf; color: #fff; ${padding}`, ""],
    ...[`color: #6cc; ${padding}`, ""],
    ...[],
    ...[`background: #e00; color: #9ff; ${padding}`, ""],
    ...[`${padding}`, ""],
    ...[],
  ];

  if (typeof window === "undefined") {
    console.info(pkgInfo.replace(/%c/g, " * "));
  } else {
    console.info(pkgInfo, ...style);
  }
}, 300);
