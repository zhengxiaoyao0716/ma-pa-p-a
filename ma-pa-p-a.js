/**
 * Magic Palette for Pixel Arts.
 * https://github.com/zhengxiaoyao0716/ma-pa-p-a
 */

/**
 * @typedef {import("./types").Texture} Texture
 * @typedef {import("./types").GLChunk} GLChunk
 * @typedef {import("./types").MsgData} MsgData
 */

/** Magic Palette for Pixel Arts Application */
export class App extends EventTarget {
  /** @type {Worker[]} */
  workers = [];
  /** @type {Map<number, number>} */
  palettle = new Map();
  /** @type {{[name: string]: Texture}} */
  textures = {};

  constructor({
    imageLimit = 16, // 16MB
    chunkSize = 1 << 18, // 512 * 512
    workersNum = 8,
  } = {}) {
    super();
    this.imageLimit = imageLimit;
    this.chunkSize = chunkSize;
    this.workersNum = workersNum;
    this.workerPollIndex = 0;
  }

  //#region worker pools

  get workersNum() {
    return this.workers.length;
  }

  set workersNum(num) {
    const { length } = this.workers;
    if (num <= length) {
      for (let i = num; i < length; i++) {
        const worker = this.workers.pop();
        // worker.terminate();
        worker.postMessage({ type: "safe-close" });
      }
      return;
    }
    const url = new URL("./ma-pa-p-a.worker.js", import.meta.url);
    /** @param {MessageEvent<{type: keyof MsgData}>} event . */
    const onMessage = ({ data: { type, ...data } }) => {
      this.response[type].call(this, data);
    };
    for (let i = length; i < num; i++) {
      const worker = new Worker(url, { name: `MaPaPA-Worker#${i}` });
      worker.addEventListener("message", onMessage);
      this.workers.push(worker);
    }
  }

  /** @type {import("./types").MsgRequest} */
  request = ({ trans, ...req }) => {
    const worker = this.workers[this.workerPollIndex];
    this.workerPollIndex = (1 + this.workerPollIndex) % this.workers.length;
    worker.postMessage(req, trans);
  };

  /** @type {import("./types").MsgResponse} */
  response = {
    parseGzip: ({ name, buffer }) => {
      // TODO
      console.log("TODO on parsed gzip", name, buffer);
    },
    parseImage: ({ name, ...chunk }) => {
      const colorNum = (this.palettle.size + chunk.plte.length) >> 1;
      if (colorNum > 256) {
        console.error(
          `[ma-pa-p-a] too many colors, name: ${name}, limit: ${256}, count: ${colorNum}+`
        );
        return;
      }
      for (let i = 0; i < chunk.plte.length; i += 2) {
        const color = chunk.plte[i];
        const count = chunk.plte[i + 1];
        this.palettle.set(color, (this.palettle.get(color) ?? 0) + count);
      }
      this.dispatchEvent(
        new CustomEvent("updatePalette", { detail: this.palettle })
      );
      const { $canvas } = this.textures[name];
      // ctx.putImageData(new ImageData(data, w, h), x, y);
      /** @type {GLChunk} */
      $canvas.dispatchEvent(new CustomEvent("fillChunk", { detail: chunk }));
    },
  };

  //#endregion

  /**
   * render image
   * @param {Texture} texture .
   * @param {HTMLImageElement} $image .
   */
  parseImage({ name, $canvas }, $image) {
    $canvas.width = $image.width;
    $canvas.height = $image.height;
    let indexer = 0;
    for (const rect of chunkRects($image, this.chunkSize)) {
      const id = indexer++;
      window.createImageBitmap($image, ...rect).then((bitmap) => {
        this.request({
          type: "parseImage",
          name,
          id,
          rect,
          bitmap,
          trans: [bitmap],
        });
      });
    }
    new WebGLService($canvas).init();
  }

  /** @param {File} file . */
  parseTexture(file) {
    if (file.size > this.imageLimit << 20) {
      const size = (file.size / 1024).toFixed(2);
      console.error(
        `[ma-pa-p-a] file too large, size: ${size}KB, max: ${this.imageLimit}MB`
      );
      return;
    }
    if (file.name in this.textures) {
      console.warn(`[ma-pa-p-a] duplicated file, name: ${file.name}`);
      return;
    }
    /** @type {Texture} */ const texture = {
      name: file.name,
      $canvas: document.createElement("canvas"),
    };
    texture.$canvas.title = file.name;
    texture.$canvas.classList.add("loading");

    const $image = new Image();
    $image.addEventListener("load", (event) => {
      this.parseImage(texture, event.currentTarget);
      texture.$canvas.classList.remove("loading");
      URL.revokeObjectURL($image.src);
    });
    $image.src = URL.createObjectURL(file);

    this.textures[file.name] = texture;
    this.dispatchEvent(new CustomEvent("createImage", { detail: texture }));
  }

  clearCache() {
    this.palettle = new Map();
    this.textures = {};
    this.dispatchEvent(new CustomEvent("clear"));
  }

  /** @param {FileList} sources . */
  handleUpload = (sources) => {
    // this.clearCache();
    for (const source of sources) {
      const index = source.name.lastIndexOf(".");
      switch (source.name.slice(1 + index)) {
        case "png":
        case "webp": {
          this.parseTexture(source);
          break;
        }
        case "mppa": {
          this.request({
            type: "parseGzip",
            url: URL.createObjectURL(source),
            name: source.name.slice(0, index),
          });
          break;
        }
        default: {
          console.warn(`unknown file type, name: ${source.name}`);
          break;
        }
      }
    }
    this.dispatchEvent(new CustomEvent("uploaded", { detail: sources }));
  };
}

class WebGLService {
  static GLSL_CODES = {
    VERTEX_SHADER: `#version 300 es
precision highp float;

layout (location = 0) in vec2 vertex;
out vec2 uv;

uniform vec2 trans;
uniform vec2 offset;

void main() {
  vec2 pos = vertex * trans * 2.0;
  pos = vec2(pos.x - 1.0, 1.0 - pos.y);
  uv = vertex - offset;

  gl_Position = vec4(pos, 0.0, 1.0);
}
`,
    FRAGMENT_SHADER: `#version 300 es
precision highp int;
precision highp float;

in vec2 uv;
out vec4 fragColor;

uniform lowp usampler2D dataTex;
uniform sampler2D colorsMap;

void main() {
  lowp uint index = texelFetch(dataTex, ivec2(uv), 0).r;
  fragColor = texelFetch(colorsMap, ivec2(index, 0), 0);
}
`,
  };

  /**
   * constructor.
   *
   * @param {HTMLCanvasElement} $canvas .
   * @param {number} chunkNum .
   */
  constructor($canvas) {
    const gl = $canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (gl == null) {
      throw new Error("your browser doesn't support WebGL2.");
    }
    const program = gl.createProgram();
    if (program == null) {
      throw new Error("create shader program failed.");
    }
    linkShaderProgram(gl, program, WebGLService.GLSL_CODES);
    this.gl = gl;
    this.program = program;
  }

  init() {
    const { gl, program } = this;

    // #region vertexArray
    this.vertexArray = gl.createVertexArray();
    gl.bindVertexArray(this.vertexArray);

    const indicesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indicesBuffer);
    const pointsBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pointsBuffer);

    const vertexLoc = 0;
    gl.vertexAttribPointer(vertexLoc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vertexLoc);

    gl.bindVertexArray(null);
    //#endregion

    this.offsetLoc = gl.getUniformLocation(program, "offset");

    /** @type {WebGLTexture[]} */ this.textures = [];
    this.dataTexLoc = gl.getUniformLocation(program, "dataTex");
    this.colorsMapLoc = gl.getUniformLocation(program, "colorsMap");
    for (let i = 0; i < 2; i++) {
      gl.activeTexture(gl[`TEXTURE${i}`]);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      this.textures.push(texture);

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    gl.canvas.addEventListener("fillChunk", this.chunk.bind(this));
    this.reset();
  }

  reset() {
    const { gl, program } = this;
    const { width, height } = gl.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    const transLoc = gl.getUniformLocation(program, "trans");
    gl.uniform2f(transLoc, 1 / width, 1 / height);
  }

  /**
   * fill WebGL chunk.
   *
   * @param {CustomEvent<GLChunk>} event .
   */
  chunk({ detail: { rect, align, data, plte } }) {
    const { gl } = this;
    const [x, y, w, h] = rect;
    gl.bindVertexArray(this.vertexArray);

    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const points = new Float32Array([x, y + h, x, y, x + w, y, x + w, y + h]);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);

    gl.uniform2f(this.offsetLoc, x, y);

    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    // if ((align & 0b11) !== 0) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      /* target */ gl.TEXTURE_2D,
      /* level */ 0,
      /* internalformat */ gl.R8UI,
      /* width */ align,
      /* height */ h,
      /* border */ 0,
      /* format */ gl.RED_INTEGER,
      /* type */ gl.UNSIGNED_BYTE,
      /* pixels */ data
    );
    gl.uniform1i(this.dataTexLoc, 0);

    const colorsMap = new Uint8Array(plte.byteLength >> 1);
    for (let i = 0; i < colorsMap.length; i++) {
      // 0,1,2,3 = plte[0]; 4,5,6,7 = plte[2]; 8,9,11 = plte[4];
      //   => 4N + k = plte[2N]; i = plte[i / 4 * 2]
      const color = plte[(i >> 2) << 1];
      const bit = ((3 - i) & 0b11) << 3;
      colorsMap[i] = (color >>> bit) & 0xff;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    gl.texImage2D(
      /* target */ gl.TEXTURE_2D,
      /* level */ 0,
      /* internalformat */ gl.RGBA,
      /* width */ colorsMap.length >> 2,
      /* height */ 1,
      /* border */ 0,
      /* format */ gl.RGBA,
      /* type */ gl.UNSIGNED_BYTE,
      /* pixels */ colorsMap
    );
    gl.uniform1i(this.colorsMapLoc, 1);

    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }
}

//#region utils

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
 * @param {HTMLCanvasElement} $canvas .
 * @param {string} name .
 * @param {"png" | "webp"} [format="webp"]
 */
function exportImage($canvas, name, format = "webp") {
  $canvas.toBlob(
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
 * link WebGL shader program.
 *
 * @param {WebGL2RenderingContext} gl .
 * @param {WebGLProgram} program .
 * @param {{[name in "VERTEX_SHADER" | "FRAGMENT_SHADER"]: string}} codes .
 */
function linkShaderProgram(gl, program, codes) {
  for (const [name, code] of Object.entries(codes)) {
    const shader = gl.createShader(gl[name]);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      throw new Error(`compile shader script failed, message: ${message}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    throw new Error(`link shader program failed, message: ${message}`);
  }
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

function paletteColor(index, color, count) {
  const $color = document.createElement("a");
  $color.id = `color${color}`;
  $color.href = "javascript:void(0);";
  const num =
    count < 1000
      ? `${count}`
      : count < 1000000
      ? `${(count / 1000).toFixed(2)}K`
      : `${(count / 1000000).toFixed(2)}M`;
  $color.title = `${index}. ${color}: ${num}`;
  if (color === "#00000000") {
    $color.classList.add("tp-grid");
  } else {
    $color.style.backgroundColor = color;
  }
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
  app.addEventListener("clear", () => {
    $panel.innerHTML =
      '<a id="color#00000000" href="javascript:void(0);" class="tp-grid" />';
  });
  app.addEventListener(
    "updatePalette",
    /** @param {CustomEvent<Map<number, number>>} event . */ (event) => {
      $panel.innerHTML = "";
      const colors = Array.from(event.detail.entries());
      colors.sort(([_rgba1, count1], [_rgba2, count2]) =>
        count1 < count2 ? 1 : count1 > count2 ? -1 : 0
      );
      for (let index = 0; index < colors.length; index++) {
        const [rgba, count] = colors[index];
        const color = `#${rgba.toString(16).padStart(8, "0")}`;
        const $color = paletteColor(index, color, count);
        $panel.appendChild($color);
      }
    }
  );
  listenUpload($panel, app.handleUpload); // 防呆设计
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
  app.addEventListener("clear", () => {
    $images.innerHTML = "";
  });
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
 */
export function render(app, root = ".mppa") {
  const $root =
    root instanceof HTMLElement ? root : document.querySelector(root);
  $root.appendChild(createTitlebar(app));
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
