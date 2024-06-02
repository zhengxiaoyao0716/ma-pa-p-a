/**
 * Magic Palette for Pixel Arts.
 * https://github.com/zhengxiaoyao0716/ma-pa-p-a
 */

/**
 * @typedef {import("./types").Texture} Texture
 * @typedef {import("./types").MsgData} MsgData
 */

/** Magic Palette for Pixel Arts Application */
export class App extends EventTarget {
  /** @type {{[rgba: string]: number}} */
  palettle = new Map();
  /** @type {{[name: string]: Texture}} */
  textures = {};

  constructor({
    imageLimit = 16,
    colorLimit = 64,
    chunkSize = 1 << 18,
    workersNum = 8,
  } = {}) {
    super();
    this.imageLimit = imageLimit;
    this.colorLimit = colorLimit;
    this.chunkSize = chunkSize;
    this.workers = this.createWorkers(workersNum);
    this.workerPollIndex = 0;
  }

  //#region worker pools

  createWorkers(/** @type {number} */ num) {
    const url = new URL("./ma-pa-p-a.worker.js", import.meta.url);
    /** @param {MessageEvent<{type: keyof MsgData}>} event . */
    const onMessage = ({ data: { type, ...data } }) => {
      this.response[type].call(this, data);
    };
    return Array.from({ length: num }, (_, i) => {
      const worker = new Worker(url, { name: `MaPaPA-Worker#${i}` });
      worker.addEventListener("message", onMessage);
      return Object.freeze(worker);
    });
  }

  /** @type {import("./types").MsgRequest} */
  request = ({ trans, ...req }) => {
    const worker = this.workers[this.workerPollIndex];
    this.workerPollIndex = (1 + this.workerPollIndex) % this.workers.length;
    worker.postMessage(req, trans);
  };

  /** @type {import("./types").MsgResponse} */
  response = {
    parse: ({ name, x, y, w, h, dict, data }) => {
      for (const [rgba, num] of Object.entries(this.palettle)) {
        dict[rgba] = num + (dict[rgba] ?? 0);
      }
      const colorNum = Object.keys(dict).length;
      if (colorNum > this.colorLimit) {
        console.error(
          `Too many colors, name: ${name}, limit: ${this.colorLimit}, count: ${colorNum}, rect: [${x}, ${y}, ${w}, ${h}]`
        );
        return;
      }
      this.palettle = dict;
      this.dispatchEvent(new CustomEvent("updatePalette", { detail: dict }));
      const { context } = this.textures[name];
      context.putImageData(new ImageData(data, w, h), x, y);
    },
  };

  //#endregion

  /**
   * render image
   * @param {Texture} texture .
   * @param {HTMLImageElement} $image .
   */
  parseImage({ filename, $canvas }, $image) {
    $canvas.width = $image.width;
    $canvas.height = $image.height;
    for (const [x, y, w, h] of chunkRects($image, this.chunkSize)) {
      window.createImageBitmap($image, x, y, w, h).then((bitmap) => {
        this.request({
          type: "parse",
          name: filename,
          x,
          y,
          limit: this.colorLimit,
          bitmap,
          trans: [bitmap],
        });
      });
    }
  }

  /** @param {File} file . */
  parseTexture(file) {
    if (file.size > this.imageLimit << 20) {
      const size = (file.size / 1024).toFixed(2);
      console.error(
        `file too large, size: ${size}KB, max: ${this.imageLimit}MB`
      );
      return;
    }
    const $canvas = document.createElement("canvas");
    /** @type {Texture} */ const texture = {
      filename: file.name,
      imageSrc: URL.createObjectURL(file),
      $canvas,
      context: $canvas.getContext("2d"),
    };
    texture.$canvas.classList.add("loading");

    const $image = new Image();
    $image.addEventListener("load", (event) => {
      this.parseImage(texture, event.currentTarget);
      texture.$canvas.classList.remove("loading");
    });
    $image.src = texture.imageSrc;

    this.textures[file.name] = texture;
    this.dispatchEvent(new CustomEvent("createImage", { detail: texture }));
  }

  clearCache() {
    for (const { imageSrc, $canvas } of Object.values(this.textures)) {
      $canvas.remove();
      URL.revokeObjectURL(imageSrc);
    }
    this.palettle = {};
    this.textures = {};
  }

  /** @param {FileList} sources . */
  handleUpload(sources) {
    // this.clearCache();
    for (const source of sources) {
      switch (source.type) {
        case "image/png":
        case "image/jpeg":
          this.parseTexture(source);
          break;
      }
    }
    this.dispatchEvent(new CustomEvent("uploaded", { detail: sources }));
  }

  /** @param {HTMLElement} $target . */
  listenUploader($target) {
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
      const { files } = event.dataTransfer;
      this.handleUpload(files);
    });
  }
}

//#region utils

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
 * create uploader.
 *
 * @param {App} app .
 * @returns uploader element
 */
function createUploader(app) {
  const $input = document.createElement("input");
  $input.type = "file";
  $input.multiple = true;
  $input.addEventListener("input", (event) => {
    const { files } = event.currentTarget;
    app.handleUpload(files);
  });
  app.addEventListener("uploaded", (event) => {
    $input.files = event.detail;
  });

  const $label = document.createElement("label");
  $label.id = "uploader";
  $label.innerHTML = "<span>Drag the image here.</span>";
  $label.appendChild($input);
  app.listenUploader($label);
  return $label;
}

/**
 * create palettle.
 *
 * @param {App} app .
 * @returns palettle element
 */
function createPalettle(app) {
  const $panel = document.createElement("div");
  $panel.id = "palettle";
  $panel.innerHTML =
    '<a id="color#00000000" href="javascript:void(0);" class="tp-grid" />';
  app.addEventListener(
    "updatePalette",
    /** @param {CustomEvent<{[rgba: string]: number}>} event . */ (event) => {
      $panel.innerHTML = "";
      const colors = Object.entries(event.detail).sort(
        ([_rgba1, count1], [_rgba2, count2]) =>
          count1 < count2 ? 1 : count1 > count2 ? -1 : 0
      );
      // console.log(colors.map(([rgba, count]) => `${rgba}: ${count}`));
      for (let index = 0; index < colors.length; index++) {
        const [rgba, count] = colors[index];
        const $color = document.createElement("a");
        $color.id = `color${rgba}`;
        $color.href = "javascript:void(0);";
        $color.title = `${index}. ${rgba}: ${count}`;
        if (rgba === "#00000000") {
          $color.classList.add("tp-grid");
        }
        $color.style.backgroundColor = rgba;
        $panel.appendChild($color);
      }
    }
  );
  app.listenUploader($panel); // 防呆设计
  return $panel;
}

/**
 * create textures.
 *
 * @param {App} app .
 * @returns textures element
 */
function createTextures(app) {
  const $images = document.createElement("div");
  $images.id = "images";
  app.addEventListener(
    "createImage",
    /** @param {CustomEvent<Texture>} event . */ ({ detail: { $canvas } }) => {
      $images.appendChild($canvas);
    }
  );

  const $panel = document.createElement("div");
  $panel.id = "textures";
  $panel.classList.add("tp-grid");
  $panel.appendChild($images);
  app.listenUploader($panel); // 防呆设计
  return $panel;
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
 */
export function render(app, root = "#mapapa") {
  const $root =
    root instanceof HTMLElement ? root : document.querySelector(root);
  $root.appendChild(createUploader(app));
  $root.appendChild(createPalettle(app));
  $root.appendChild(createTextures(app));
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
export function createRoot(app, { id = "mapapa", theme = "light" } = {}) {
  const $root = document.createElement("div");
  $root.id = id;
  $root.classList.add(theme);
  render(app, $root);
  return $root;
}

/**
 * create style.
 *
 * @param {URL} [url="./ma-pa-p-a.css"] .
 * @returns style element
 */
export function createStyle(url = "./ma-pa-p-a.css") {
  const $style = document.createElement("style");
  $style.innerHTML = `@import "${new URL(url, import.meta.url)}";`;
  return $style;
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
    app = new App();

    connectedCallback() {
      const shadow = this.attachShadow({ mode });
      shadow.appendChild(createStyle());
      const theme = this.getAttribute("theme") ?? "light";
      shadow.appendChild(createRoot(this.app, { theme }));
    }
  }
  window.customElements.define(name, HTMLMaPaPAElement);
}

//

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

//#endregion
