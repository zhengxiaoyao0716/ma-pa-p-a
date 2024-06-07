export type Rect = [x: number, y: number, w: number, h: number];

export interface Texture {
  readonly data: Uint8ClampedArray; // [index0,index1,...]
  readonly plte: Uint8ClampedArray; // [r0,g0,b0,a0,r1,g1,b1,a1,...]
}

export interface Palette {
  color: number;
  count: number;
  refer: {
    [arch: string]: {
      chunk: number;
      offset: number;
    }[];
  };
  dirty?: number;
  split?: string[];
}

export interface Archive {
  readonly canvas: HTMLCanvasElement & { /*arch*/ title: string };
  readonly chunks: { readonly rect: Rect; readonly texture?: Texture }[];
}

//

export interface Msg {
  parseGzip: {
    req: {
      url: string;
      name: string;
    };
    resp: {
      name: string;
      trans: [buffer: ArrayBuffer];
    };
  };
  parseImage: {
    req: {
      arch: string;
      chunk: number;
      trans: [source: ImageBitmap];
    };
    resp: Texture & {
      arch: string;
      chunk: number;
      trans: [
        output: ImageBitmap,
        count: ArrayBuffer, // [count0,count1,...]
        plte: ArrayBuffer,
        data: ArrayBuffer
      ];
    };
  };
  updateChunk: Texture & {
    req: {
      arch: string;
      chunk: number;
      width: number;
      height: number;
      trans: [plte: ArrayBuffer, data: ArrayBuffer];
    };
    resp: Texture & {
      arch: string;
      chunk: number;
      trans: [output: ImageBitmap, plte: ArrayBuffer, data: ArrayBuffer];
    };
  };
}

export type MsgType = keyof Msg;

export interface MsgRequest {
  <T extends MsgType>(type: T, body: Msg[T]["req"]): void;
}

export type MsgRouters = {
  [T in MsgType]: (req: Msg[T]["req"]) => Promise<Msg[T]["resp"]>;
};

export type MsgHandlers = {
  [T in MsgType]: (resp: Msg[T]["resp"]) => void;
};
