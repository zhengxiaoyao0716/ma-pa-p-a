/**
 * @typedef {import("./types").Rect} Rect
 */

/** @type {import("./types").MsgRouters} */
const routers = {
  parseImage: async ({ arch, chunk, trans: [source] }) => {
    const service = await services.image;
    const output = new Uint8ClampedArray((source.width * source.height) << 2);
    /** @type {Map<number, number>} {color: count} */ const counter = new Map();
    /** @type {Map<number, number>} {color: index} */ const indexer = new Map();
    const data = service.parse(source, output, counter, indexer);
    const plte = new Uint8ClampedArray(indexer.size << 2);
    const count = new Uint32Array(indexer.size);
    for (const [color, index] of indexer.entries()) {
      plte.set(parseRGBA(color), index << 2);
      count[index] = counter.get(color);
    }
    const trans = [count.buffer, plte.buffer, data.buffer, output.buffer];
    return { arch, chunk, output, data, plte, trans };
  },

  updateChunk: async ({ arch, chunk, rect, visible, data, plte }) => {
    const service = await services.color;
    const output = service.chunk(rect, visible, data, plte);
    const trans = [output, plte.buffer, data.buffer];
    return { arch, chunk, data, plte, trans };
  },

  extract: async ({ arch, chunk, rect, visible, data, plte, mask, mapper }) => {
    const service = await services.remap;
    const mapped = service.chunk(rect, data, mask, mapper);

    const remapTo = mapper[mapper.length - 1];
    let count = 0;
    for (const color of mapped) {
      if (color !== remapTo) continue;
      count++;
      break; // FIXME
    }
    const result = {
      arch,
      chunk,
      data: mapped,
      plte,
    };
    if (count > 0) {
      const offset = remapTo << 2;
      result.mask = { code: mask.code, offset, count };
      if (plte.length <= offset) {
        result.plte = new Uint8ClampedArray(offset + 4);
        result.plte.set(plte);
        result.plte.set(parseRGBA(mask.color), offset);
      }
    }
    if (visible === undefined || count === 0) {
      result.trans = [plte.buffer, data.buffer];
    } else {
      const output = (await services.color).chunk(
        rect,
        visible,
        mapped,
        result.plte
      );
      result.trans = [output, plte.buffer, data.buffer];
    }
    return result;
  },

  exportSkin: async ({ name, skin, width, height }) => {
    const service = await services.image;
    const blob = service.dump(skin, width, height, "png");
    const url = URL.createObjectURL(await blob);
    return { name: `${name}.skin.png`, url };
  },
  exportData: async ({ name, size, rect, data, mapper }) => {
    const service = await services.remap;
    const blob = service.dump(size, rect, data, mapper, "webp");
    const resp = compress((await blob).stream(), "gzip");
    const url = URL.createObjectURL(await resp.blob());
    return { name: `${name}.data.gz`, url };
  },

  importSkin: async ({ trans: [source] }) => {
    const service = await services.image;
    const output = service.load(source, source.width, source.height);
    return { width: source.width << 2, trans: [output.buffer] };
  },
  importData: async ({ arch, plte, trans: [source] }) => {
    const service = await services.image;
    const loaded = service.load(source, source.width, source.height);
    const data = new Uint8ClampedArray(source.width * source.height);
    for (let i = 0; i < data.length; i++) {
      data[i] = loaded[i << 2];
    }
    if (plte.length === 0) {
      return { arch, data, plte, trans: [plte.buffer, data.buffer] };
    }
    const rect = [0, 0, source.width, source.height];
    const output = (await services.color).chunk(rect, null, data, plte);
    return { arch, data, plte, trans: [output, plte.buffer, data.buffer] };
  },
};

//

//#region renderer service

/**
 * @typedef {{VERTEX_SHADER: string, FRAGMENT_SHADER: string}} Shaders
 */

/** WebGL2 Service. */
class WebGL2Service {
  /** @type {WebGL2RenderingContext & {canvas: OffscreenCanvas}} */
  gl;
  /** @type {WebGLProgram} */
  program;
  /** @type {WebGLTexture[]} */
  textures = [];

  /**
   * constructor.
   *
   * @param {Shaders} shaders .
   * @param {string[]} textures .
   */
  constructor(shaders, textures) {
    const canvas = new OffscreenCanvas(512, 512);
    const gl = canvas.getContext("webgl2");
    if (gl == null) {
      throw new Error("your browser doesn't support WebGL2.");
    }
    const program = gl.createProgram();
    if (program == null) {
      throw new Error("create shader program failed.");
    }
    this.gl = gl;
    this.program = program;

    // compile shaders
    for (const [name, code] of Object.entries(shaders)) {
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

    // #region init vertexArray
    this._vertexArray = gl.createVertexArray();
    gl.bindVertexArray(this._vertexArray);

    const indicesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indicesBuffer);
    const indices = new Uint8ClampedArray([0, 1, 2, 0, 2, 3]);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const pointsBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pointsBuffer);
    const points = new Int8Array([-1, 1, -1, -1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);

    const vertexLoc = 0;
    gl.vertexAttribPointer(vertexLoc, 2, gl.BYTE, false, 0, 0);
    gl.enableVertexAttribArray(vertexLoc);

    gl.bindVertexArray(null);
    //#endregion

    /** @type {(WebGLUniformLocation | null)[]} */ this._texLocations = [];
    for (let i = 0; i < textures.length; i++) {
      gl.activeTexture(gl[`TEXTURE${i}`]);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this.textures.push(tex);
      const name = textures[i];
      const loc = gl.getUniformLocation(program, name);
      this._texLocations.push(loc);

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }

  /**
   * reset.
   *
   * @param {number} width .
   * @param {number} height .
   */
  reset(width, height) {
    // resize view
    this.gl.canvas.width = width;
    this.gl.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    // clear canvas
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.useProgram(this.program);
  }

  /**
   * render.
   */
  render() {
    for (let i = 0; i < this._texLocations.length; i++) {
      const loc = this._texLocations[i];
      if (loc != null) this.gl.uniform1i(loc, i);
    }
    this.gl.bindVertexArray(this._vertexArray);
    this.gl.drawElements(this.gl.TRIANGLES, 6, this.gl.UNSIGNED_BYTE, 0);
    this.gl.bindVertexArray(null);
  }
}

class PaintImage extends WebGL2Service {
  /** @param {Shaders} shaders . */
  constructor(shaders) {
    super(shaders, ["bitmap"]);
  }

  /**
   * parse image data.
   *
   * @param {ImageBitmap} source .
   * @param {Uint8ClampedArray} output .
   * @param {Map<number, number>} counter .
   * @param {Map<number, number>} indexer .
   * @returns {Uint8ClampedArray} data
   */
  parse(source, output, counter, indexer) {
    const { width, height } = source;
    this.reset(width, height);
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // render output
    this.render();
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);
    const view = new DataView(output.buffer);

    let offset = 0;
    const align = quatAlign(width);
    const data = new Uint8ClampedArray(align * height);
    for (let y = 0; y < height; y++) {
      const j = y * align;
      for (let x = 0; x < width; x++) {
        const i = j + x;
        const color = view.getUint32(offset);
        offset += 4;

        const count = counter.get(color);
        if (count) {
          data[i] = indexer.get(color);
          counter.set(color, 1 + count);
          continue;
        }
        data[i] = counter.size;
        indexer.set(color, counter.size);
        counter.set(color, 1);

        // colors overflow
        if (counter.size > 256) return data;
      }
    }
    return data;
  }

  /**
   * dump to image blob.
   *
   * @param {Uint8ClampedArray} source .
   * @param {number} width .
   * @param {number} height .
   * @param {"png" | "webp"} type .
   * @returns {Promise<Blob>} blob
   */
  dump(source, width, height, type) {
    this.reset(width, height);
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source
    );
    // render output
    this.render();
    return this.gl.canvas.convertToBlob({
      quality: 1,
      type: `image/${type}`,
    });
  }

  /**
   * load image data from blob.
   *
   * @param {ImageBitmap} source .
   * @param {number} width .
   * @param {number} height .
   * @returns {Uint8ClampedArray} loaded data
   */
  load(source, width, height) {
    this.reset(width, height);
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // render output
    this.render();
    const data = new Uint8ClampedArray((width * height) << 2);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return data;
  }
}

class IndexColor extends WebGL2Service {
  /** @param {Shaders} shaders . */
  constructor(shaders) {
    super(shaders, ["dataTex", "plteTex"]);
    this.transLoc = this.gl.getUniformLocation(this.program, "trans");
  }

  /**
   * render chunk.
   *
   * @param {Rect} rect .
   * @param {Rect | null} visible .
   * @param {ArrayBufferView} data .
   * @param {ArrayBufferView} plte .
   * @returns {ImageBitmap} output
   */
  chunk([x, y, w, h], visible, data, plte) {
    const align = quatAlign(w);
    const trans =
      visible == null
        ? [0, 0, w, h]
        : [visible[0] - x, visible[1] - y, visible[2], visible[3]];
    this.reset(trans[2], trans[3]);
    const { gl } = this;

    // texture0: dataTex
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      align,
      h,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      data
    );
    // texture1: plteTex
    gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      plte.length >> 2,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      plte
    );

    // render output
    gl.uniform4fv(this.transLoc, trans);
    this.render();
    return gl.canvas.transferToImageBitmap();
  }
}

class ColorRemap extends WebGL2Service {
  /** @param {Shaders} shaders . */
  constructor(shaders) {
    super(shaders, ["dataTex", "flagTex", "areaTex", "mapper"]);
    this.transLoc = this.gl.getUniformLocation(this.program, "trans");
    this.stackLoc = this.gl.getUniformLocation(this.program, "stack");
    this.maskColorLoc = this.gl.getUniformLocation(this.program, "maskColor");
  }

  /**
   * config parameters.
   *
   * @param {Rect} rect .
   * @param {ArrayBufferView} data .
   * @param {Pick<import("./types").Msg["extract"]["req"]["mask"], "flag" | "area">} mask .
   * @param {Uint8ClampedArray} mapper .
   * @param {boolean} [flipY=false] .
   * @param {boolean} [stack=false] .
   */
  config([x, y, w, h], data, mask, mapper, flipY, stack) {
    const align = quatAlign(w);
    const { gl } = this;

    // texture0: dataTex
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      align,
      h,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      data
    );

    // texture1: flagTex
    gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      mask.flag.length,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      mask.flag
    );

    // texture2: areaTex
    gl.bindTexture(gl.TEXTURE_2D, this.textures[2]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32UI,
      mask.area.length >> 2,
      1,
      0,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      mask.area
    );

    // texture3: mapper
    gl.bindTexture(gl.TEXTURE_2D, this.textures[3]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      mapper.length,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      mapper
    );

    // render output
    gl.uniform4fv(this.transLoc, [x, y, align, h]);
    gl.uniform1i(this.stackLoc, stack);
  }

  /**
   * render.
   *
   * @param {Rect} rect .
   * @param {ArrayBufferView} data .
   * @param {Pick<import("./types").Msg["extract"]["req"]["mask"], "flag" | "area">} mask .
   * @param {Uint8ClampedArray} mapper .
   * @returns {Uint8ClampedArray} mapped data
   */
  chunk(rect, data, mask, mapper) {
    const align = quatAlign(rect[2]);
    const height = rect[3];
    this.reset(align, height);

    this.config(rect, data, mask, mapper, false, true);
    this.render();
    const mapped = new Uint8ClampedArray((align * height) << 2);
    const { gl } = this;
    gl.readPixels(0, 0, align, height, gl.RGBA, gl.UNSIGNED_BYTE, mapped);
    for (let i = 0; i < mapped.length; i += 4) {
      mapped[i >> 2] = mapped[i];
    }
    return mapped.slice(0, mapped.length >> 2);
  }

  /**
   * dump to image blob.
   *
   * @param {[width: number, height: number]} size .
   * @param {Rect[]} rect .
   * @param {ArrayBufferView[]} data .
   * @param {Uint8ClampedArray[]} mapper .
   * @param {"png" | "webp"} type .
   * @returns {Promise<Blob>} blob
   */
  dump([width, height], rect, data, mapper, type) {
    this.reset(width, height);

    const flag = new Uint8ClampedArray([0]);
    for (let i = 0; i < rect.length; i++) {
      const [x, y, w, h] = rect[i];
      this.gl.viewport(x, height - y - h, w, h);
      const area = new Uint32Array([x, y, x + w, y + h]);
      this.config(rect[i], data[i], { flag, area }, mapper[i], true, false);
      this.render();
    }
    return this.gl.canvas.convertToBlob({
      quality: 1,
      type: `image/${type}`,
    });
  }
}

//

/**
 * fetch shaders.
 *
 * @param {string} name .
 * @returns {Promise<Shaders>} .
 */
async function fetchShaders(name) {
  const vert = fetch(new URL(`./shaders/${name}.vert`, import.meta.url)) //
    .then((resp) => resp.text());
  const frag = fetch(new URL(`./shaders/${name}.frag`, import.meta.url)) //
    .then((resp) => resp.text());
  return {
    VERTEX_SHADER: await vert,
    FRAGMENT_SHADER: await frag,
  };
}

const services = {
  image: fetchShaders("PaintImage").then((shaders) => new PaintImage(shaders)),
  color: fetchShaders("IndexColor").then((shaders) => new IndexColor(shaders)),
  remap: fetchShaders("ColorRemap").then((shaders) => new ColorRemap(shaders)),
};

//#endregion

//

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

/** @param {Uint8ClampedArray} data . */
function createTempPlte(data) {
  let max = 0;
  for (const color of data) {
    if (color > 255) break;
    if (color > max) max = color;
  }
  const colors = Array.from({ length: 1 + max }).flatMap((_, i) => {
    const v = Math.round((i / max) * 255);
    return [v, v, v, 255];
  });
  return new Uint8ClampedArray(colors);
}

/** @param {number} value . */
function quatAlign(value) {
  return (((value - 1) >> 2) + 1) << 2; // UNPACK_ALIGNMENT
}

/**
 * compress.
 *
 * @param {ReadableStream<Uint8Array>} stream .
 * @param {CompressionFormat} format .
 * @returns {Response} .
 */
function compress(stream, format = "gzip") {
  const compression = new CompressionStream(format);
  return new Response(stream.pipeThrough(compression));
}

self.addEventListener(
  "message",
  /** @param {MessageEvent<{type: import("./types").MsgType, body: {}}>} message . */
  async ({ data: { type, body } }) => {
    try {
      const resp = await routers[type](body);
      // await new Promise((r) => setTimeout(() => r(), Math.random() * 1000));
      self.postMessage({ type, resp }, resp.trans);
    } catch (error) {
      self.postMessage({ type, error });
    }
  }
);

//#endregion
