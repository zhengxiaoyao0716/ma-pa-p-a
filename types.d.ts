export interface Texture {
  filename: string;
  imageSrc: string;
  $canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

export interface MsgData {
  tick: { req: { text: "ping" }; resp: { text: "pong" } };
  parse: {
    req: {
      name: string;
      x: number;
      y: number;
      limit: number;
      bitmap: ImageBitmap;
      trans: [ImageBitmap];
    };
    resp: {
      name: string;
      x: number;
      y: number;
      w: number;
      h: number;
      dict: { [rgba: string]: number };
      data: Uint8ClampedArray;
      trans: [ArrayBuffer];
    };
  };
}

export interface MsgRequest {
  <T extends keyof MsgData>(
    req: { type: T; trans?: Transferable[] } & MsgData[T]["req"]
  ): void;
}

export type MsgResponse = {
  [T in keyof MsgData]: (resp: MsgData[T]["resp"]) => void;
};

export type MsgHandlers = {
  [T in keyof MsgData]: (
    req: MsgData[T]["req"]
  ) => Promise<{ trans?: Transferable[] } & MsgData[T]["resp"]>;
};
