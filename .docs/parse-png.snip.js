// 检测了很多张 png 图片，没有一张是 indexed color 格式的。
// 通过 png 文件头快速解析出调色板的想法暂时搁置。

source.arrayBuffer().then((buffer) => {
  const view = new DataView(buffer);
  // http://www.libpng.org/pub/png/spec/1.2/PNG-Chunks.html#C.PLTE
  if (view.getUint32(0) !== 0x89504e47) return;
  if (view.getUint32(4) !== 0x0d0a1a0a) return;

  // view.getUint32(8) === 13 // // IHDR dataLen
  // view.getUint32(12) === 0x49484452 // code of "IHDR"
  // view.getUint32(16) // width
  // view.getUint32(20) // height
  // view.getUint8(24) // bit depth

  if (view.getUint8(25) !== 3) return;
  /* color type 3 (indexed color) */

  // view.getUint8(26)) // compression method
  // view.getUint8(27)) // filter method
  // view.getUint8(28)) // fnterface method

  let offset =
    /*HEAD*/ 8 +
    /*LEN*/ 4 +
    /*TYPE*/ 4 +
    /*DATA*/ view.getUint32(8) +
    /*CRC*/ 4;

  // const codePLTE =
  //   Array.from("PLTE")
  //     .map((c, i) => c.charCodeAt(0) << ((3 - i) << 3))
  //     .reduce((l, r) => l + r) >>> 0;
  const codePLTE = 0x504c5445;
  const codeIDAT = 0x49444154;
  const codeIEND = 0x49454e44;

  while (offset < view.byteLength) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    console.log(
      "type",
      String.fromCharCode(
        ...[
          type >> 24,
          (type & 0xff0000) >> 16,
          (type & 0xff00) >> 8,
          type & 0xff,
        ]
      )
    );
    switch (type) {
      case codePLTE: {
        console.log("!!! found PLTE !!!", offset, length);
        return;
      }
      case codeIDAT:
      case codeIEND: {
        return;
      }
      default: {
        offset += /*LEN*/ 4 + /*TYPE*/ 4 + length + /*CRC*/ 4;
        break;
      }
    }
  }
});
