export type Rect = [x: number, y: number, w: number, h: number];

export interface Texture {
  readonly data: Uint8ClampedArray; // [index0,index1,...]
  readonly plte: Uint8ClampedArray; // [r0,g0,b0,a0,r1,g1,b1,a1,...]
}

export interface Palette {
  code: string;
  color: number;
  count: number;
  refer: {
    [arch: string]: {
      chunk: number;
      offset: number;
    }[];
  };
  layers: number[];
  disable: boolean;
}

export interface Archive {
  readonly name: string;
  readonly ctx: CanvasRenderingContext2D;
  readonly size: [width: number, height: number];
  readonly chunks: { readonly rect: Rect; readonly texture?: Texture }[];
  zoom?: {
    area: Rect;
    visible: Map<number, Rect>;
  };
  mask?: { type: "select" | "cutout"; area: Rect | null }[];
}

//

export interface Msg {
  parseImage: {
    req: {
      arch: string;
      chunk: number;
      trans: [source: ImageBitmap];
    };
    resp: Texture & {
      arch: string;
      chunk: number;
      output: Uint8ClampedArray;
      trans: [
        count: ArrayBufferLike, // [count0,count1,...]
        output: ArrayBufferLike,
        plte: ArrayBufferLike,
        data: ArrayBufferLike
      ];
    };
  };

  updateChunk: {
    req: Texture & {
      arch: string;
      chunk: number;
      rect: Rect;
      visible: Rect | null;
      trans: [plte: ArrayBufferLike, data: ArrayBufferLike];
    };
    resp: Texture & {
      arch: string;
      chunk: number;
      trans: [
        output: ImageBitmap,
        plte: ArrayBufferLike,
        data: ArrayBufferLike
      ];
    };
  };

  extract: {
    req: Texture & {
      arch: string;
      chunk: number;
      rect: Rect;
      visible: Rect | null | undefined;
      mask: {
        flag: Uint8ClampedArray; // bits of select(0) or cutout(1)
        area: Uint32Array; // [left0,top0,right0,bottom0,...]
        code: string;
        color: number;
      };
      mapper: Uint8ClampedArray; // [rawIndex: remapTo]
      trans: [
        mapper: ArrayBufferLike,
        plte: ArrayBufferLike,
        data: ArrayBufferLike
      ];
    };
    resp: Texture & {
      arch: string;
      chunk: number;
      mask?: {
        code: string;
        count: number;
        offset: number;
      };
      trans:
        | [output: ImageBitmap, plte: ArrayBufferLike, data: ArrayBufferLike]
        | [plte: ArrayBufferLike, data: ArrayBufferLike];
    };
  };

  exportSkin: {
    req: {
      name: string;
      skin: Uint8ClampedArray;
      width: number;
      height: number;
      trans: [skin: ArrayBufferLike];
    };
    resp: {
      name: string;
      url: string;
    };
  };
  exportData: {
    req: {
      name: string;
      size: [width: number, height: number];
      rect: Rect[];
      data: Uint8ClampedArray[]; // clone
      mapper: Uint8ClampedArray[]; // trans
      trans: [...mapper: ArrayBufferLike[]];
    };
    resp: {
      name: string;
      url: string;
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
