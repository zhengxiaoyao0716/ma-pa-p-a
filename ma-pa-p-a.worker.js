/**
 * @typedef {import("./types").MsgData} MsgData
 */

const $canvas = new OffscreenCanvas(512, 512);
const ctx = $canvas.getContext("2d", { willReadFrequently: true });

/** @type {import("./types".MsgHandlers)} */
const handlers = {
  "safe-close"() {
    console.debug(`[ma-pa-p-a] worker close, name: ${self.name}`);
    self.close();
  },

  async parseGzip({ url, name }) {
    const blob = await fetch(url).then((resp) => resp.blob());
    URL.revokeObjectURL(url);
    const buffer = await decompress(blob.stream()).arrayBuffer();
    return { name, buffer, trans: [buffer] };
  },

  async parseImage({ name, id, rect, bitmap }) {
    const { width, height } = bitmap;
    $canvas.width = width;
    $canvas.height = height;
    ctx.drawImage(bitmap, 0, 0);
    const source = ctx.getImageData(0, 0, width, height);

    /** @type {Map<number, number>} */
    const counter = new Map();
    /** @type {Map<number, number>} */
    const indexer = new Map();
    // const align = width;
    const align = (((width - 1) >> 2) + 1) << 2; // UNPACK_ALIGNMENT

    const data = parseImageData(source, counter, indexer, align);
    const plte = new Uint32Array(indexer.size * 2);
    for (const [color, index] of indexer.entries()) {
      const i = index << 1;
      plte[i] = color;
      plte[i + 1] = counter.get(color);
    }
    // await new Promise((r) => setTimeout(() => r(), Math.random() * 1000));
    return {
      name,
      id,
      rect,
      align,
      data,
      plte,
      trans: [data.buffer],
    };
  },
};

//

//#region utils

/**
 * parse image data.
 *
 * @param {ImageData} source .
 * @param {Map<number, number>} counter .
 * @param {Map<number, number>} indexer .
 * @param {Number} align .
 * @returns {Uint8ClampedArray} data
 */
function parseImageData(source, counter, indexer, align) {
  const { width, height } = source;
  const data = new Uint8ClampedArray(align * height);
  const view = new DataView(source.data.buffer);

  let offset = 0;
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
  /** @param {MessageEvent<{type: keyof MsgData}>} message . */
  async ({ data: { type, ...data } }) => {
    const { trans, ...resp } = await handlers[type](data);
    if (resp) self.postMessage({ type, ...resp }, trans);
  }
);

//#endregion
