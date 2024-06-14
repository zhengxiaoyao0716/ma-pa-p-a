/** @type {import("./types").MsgRouters} */
const routers = {
  parseGzip: async ({ url, name }) => {
    const blob = await fetch(url).then((resp) => resp.blob());
    URL.revokeObjectURL(url);
    const buffer = await decompress(blob.stream()).arrayBuffer();
    return { name, trans: [buffer] };
  },

  parseImage: async ({ arch, chunk, trans: [source] }) => {
    /** @type {Map<number, number>} {color: count} */ const counter = new Map();
    /** @type {Map<number, number>} {color: index} */ const indexer = new Map();
    const { width, height } = source;
    const align = alignWidth(width);

    const data = services.canvas.parse(source, counter, indexer, align);
    const plte = new Uint8ClampedArray(indexer.size << 2);
    const count = new Uint32Array(indexer.size);
    for (const [color, index] of indexer.entries()) {
      plte.set(parseRGBA(color), index << 2);
      count[index] = counter.get(color);
    }
    const rect = [0, 0, width, height];
    const output = services.webgl2.chunk(rect, null, align, data, plte);
    const trans = [output, count.buffer, plte.buffer, data.buffer];
    return { arch, chunk, data, plte, trans };
  },

  updateChunk: async ({ arch, chunk, rect, visible, data, plte }) => {
    const align = alignWidth(rect[2]);
    const output = services.webgl2.chunk(rect, visible, align, data, plte);
    const trans = [output, plte.buffer, data.buffer];
    return { arch, chunk, data, plte, trans };
  },

  dumpPalettes: async ({ name, plte, width, height }) => {
    // return { name: `${name}.mppa`, url: URL.createObjectURL(new Blob([plte])) };
    const url = services.canvas.dump(plte, width, height, "png");
    return { name: `${name}.png`, url: await url };
  },
  dumpArchives: async ({ name, data }) => {
    // TODO
  },
};

//

//#region renderer service

class CanvasService {
  constructor() {
    const canvas = new OffscreenCanvas(512, 512);
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * parse image data.
   *
   * @param {ImageBitmap} source .
   * @param {Map<number, number>} counter .
   * @param {Map<number, number>} indexer .
   * @param {Number} align .
   * @returns {Uint8ClampedArray} data
   */
  parse(source, counter, indexer, align) {
    const { width, height } = source;
    this.ctx.canvas.width = width;
    this.ctx.canvas.height = height;
    this.ctx.drawImage(source, 0, 0);
    const raw = this.ctx.getImageData(0, 0, width, height);
    const view = new DataView(raw.data.buffer);

    let offset = 0;
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
   * dump to iamge blob.
   *
   * @param {Uint8ClampedArray} source .
   * @param {number} width .
   * @param {number} height .
   * @param {"png" | "webp"} type .
   * @returns {Promise<Blob>}
   */
  async dump(source, width, height, type) {
    this.ctx.canvas.width = width;
    this.ctx.canvas.height = height;
    const data = new ImageData(source, width, height);
    this.ctx.putImageData(data, 0, 0);
    const blob = this.ctx.canvas.convertToBlob({
      quality: 1,
      type: `image/${type}`,
    });
    return URL.createObjectURL(await blob);
  }
}

class WebGL2Service {
  static GLSL_CODES = {
    VERTEX_SHADER: `#version 300 es
precision highp float;

layout (location = 0) in vec2 vertex;
out vec2 uv;

void main() {
  uv = vec2(0.5, -0.5) * vertex + vec2(0.5);
  gl_Position = vec4(vertex, 0.0, 1.0);
}
`,
    FRAGMENT_SHADER: `#version 300 es
precision highp int;
precision highp float;

in vec2 uv;
out vec4 fragColor;

uniform vec4 trans;
uniform lowp usampler2D dataTex;
uniform sampler2D plteTex;

void main() {
  ivec2 pos = ivec2(uv * trans.zw + trans.xy);
  lowp uint index = texelFetch(dataTex, pos, 0).r;
  fragColor = texelFetch(plteTex, ivec2(index, 0), 0);
}
`,
  };

  constructor() {
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
    for (const [name, code] of Object.entries(WebGL2Service.GLSL_CODES)) {
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
    this.vertexArray = gl.createVertexArray();
    gl.bindVertexArray(this.vertexArray);

    const indicesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indicesBuffer);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const pointsBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pointsBuffer);
    const points = new Float32Array([-1, 1, -1, -1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);

    const vertexLoc = 0;
    gl.vertexAttribPointer(vertexLoc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vertexLoc);

    gl.bindVertexArray(null);
    //#endregion

    this.transLoc = gl.getUniformLocation(program, "trans");
    this.dataTexLoc = gl.getUniformLocation(program, "dataTex");
    this.plteTexLoc = gl.getUniformLocation(program, "plteTex");

    /** @type {WebGLTexture[]} */ this.textures = [];
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
  }

  /**
   * render chunk.
   *
   * @param {import("./types").Rect} rect .
   * @param {import("./types").Rect | null} visible .
   * @param {number} align .
   * @param {ArrayBufferView} data .
   * @param {ArrayBufferView} plte .
   * @returns {ImageBitmap} output
   */
  chunk([x, y, w, h], visible, align, data, plte) {
    const { gl, program } = this;
    // resize and clear view
    gl.canvas.width = w;
    gl.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    const trans =
      visible == null
        ? [0, 0, w, h]
        : [visible[0] - x, visible[1] - y, visible[2], visible[3]];

    // texture0: dataTex
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    // gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
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

    // texture1: plteTex
    gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    gl.texImage2D(
      /* target */ gl.TEXTURE_2D,
      /* level */ 0,
      /* internalformat */ gl.RGBA,
      /* width */ plte.length >> 2,
      /* height */ 1,
      /* border */ 0,
      /* format */ gl.RGBA,
      /* type */ gl.UNSIGNED_BYTE,
      /* pixels */ plte
    );

    // render output
    gl.bindVertexArray(this.vertexArray);
    gl.uniform4fv(this.transLoc, trans);
    gl.uniform1i(this.dataTexLoc, 0);
    gl.uniform1i(this.plteTexLoc, 1);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    return gl.canvas.transferToImageBitmap();
  }
}

const services = { canvas: new CanvasService(), webgl2: new WebGL2Service() };

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

/** @param {number} width . */
function alignWidth(width) {
  return (((width - 1) >> 2) + 1) << 2; // UNPACK_ALIGNMENT
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

/**
 * decompress.
 *
 * @param {ReadableStream<Uint8Array>} stream .
 * @param {CompressionFormat} format .
 * @returns {Response} .
 */
function decompress(stream, format = "gzip") {
  const decompression = new DecompressionStream(format);
  return new Response(stream.pipeThrough(decompression));
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
