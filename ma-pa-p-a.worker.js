/**
 * @typedef {import("./types").MsgData} MsgData
 */

const canvas = new OffscreenCanvas(512, 512);
const ctx = canvas.getContext("2d", { willReadFrequently: true });

/** @type {import("./types".MsgHandlers)} */
const handlers = {
  async parse({ name, x, y, limit, bitmap }) {
    const { width: w, height: h } = bitmap;
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const view = new DataView(data.buffer);
    /** @type { [rgba: string]: number } */
    const dict = {};
    let colorNum = 0;
    for (let i = 0; i < view.byteLength; i += 4) {
      const rgba = `#${view.getUint32(i).toString(16).padStart(8, "0")}`;
      const count = dict[rgba];
      if (count) {
        dict[rgba] = 1 + count;
        continue;
      }
      dict[rgba] = 1;
      if (++colorNum > limit) break;
    }
    // await new Promise((r) => setTimeout(() => r(), Math.random() * 1000));
    return { name, x, y, w, h, dict, data, trans: [data.buffer] };
  },
};

//

self.addEventListener(
  "message",
  /** @param {MessageEvent<{type: keyof MsgData}>} message . */
  async ({ data: { type, ...data } }) => {
    const { trans, ...resp } = await handlers[type](data);
    self.postMessage({ type, ...resp }, trans);
  }
);
