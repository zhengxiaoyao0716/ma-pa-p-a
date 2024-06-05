export interface Texture {
  readonly name: string;
  readonly $canvas: HTMLCanvasElement;
}

//

export interface GLChunk {
  id: number;
  rect: [x: number, y: number, w: number, h: number];
  align: number; // w % 4 === 0 ? w : w + 4 - (w % 4)
  data: Uint8ClampedArray; // [index0,index1,...]
  plte: Uint32Array; // [color0,count0,color1,count1,...]
}

//

export interface MsgData {
  parseGzip: {
    req: {
      url: string;
      name: string;
    };
    resp: {
      buffer: ArrayBuffer;
      trans: [ArrayBuffer];
    };
  };
  parseImage: {
    req: {
      name: string;
      id: number;
      rect: [x: number, y: number, w: number, h: number];
      bitmap: ImageBitmap;
      trans: [ImageBitmap];
    };
    resp: {
      name: string;
      trans: [ArrayBuffer, ArrayBuffer, ArrayBuffer];
    } & GLChunk;
  };
}

export interface MsgRequest {
  <T extends keyof MsgData>(
    req: { type: T; trans?: Transferable[] } & MsgData[T]["req"]
  ): void;
}

export type MsgResponse = {
  [T in keyof MsgData]: (
    resp: Omit<MsgData[T]["resp"], "type" | "trans">
  ) => void;
};

export type MsgHandlers = {
  [T in keyof MsgData]: (
    req: Omit<MsgData[T]["req"], "type" | "trans">
  ) => Promise<{ trans?: Transferable[] } & MsgData[T]["resp"]>;
} & { "safe-close"(): void };
