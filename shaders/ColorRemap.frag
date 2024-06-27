#version 300 es
precision highp int;
precision highp float;

in vec2 uv;
out vec4 fragColor;

uniform vec4 trans;
uniform lowp usampler2D dataTex;
uniform lowp usampler2D flagTex;
uniform highp usampler2D areaTex;
uniform lowp usampler2D mapper;

bool hasPoint(vec4 area, float x, float y) {
  float has = step(area.x, x); // 0.0 if x < left else 1.0
  has += step(area.y, y); // 0.0 if y < top else 1.0
  has += step(x, area.z); // 0.0 if right < x else 1.0
  has += step(y, area.w); // 0.0 if bottom < y else 1.0
  return 4.0 <= has; // false if has < 4.0 else true
}

uint applyMask(uint rawColor, int size, float x, float y) {
  uint mapped = texelFetch(mapper, ivec2(rawColor, 0), 0).r;
  if (mapped == 255u) return rawColor;

  for (int i = size - 1; i >= 0; i--) {
    uvec4 area = texelFetch(areaTex, ivec2(i, 0), 0);
    if (hasPoint(vec4(area), x, y)) {
      uint flag = texelFetch(flagTex, ivec2(i >> 3, 0), 0).r;
      bool cutout = (flag & uint(1 << (i & 7))) != 0u;
      return cutout ? rawColor : mapped;
    }
  }
  return rawColor;
}

void main() {
  uvec4 color = texelFetch(dataTex, ivec2(uv), 0);

  float x = float(int(uv.x) << 2) + trans.x;
  float y = uv.y + trans.y;
  int size = textureSize(areaTex, 0).x;
  fragColor = vec4(
    applyMask(color.r, size, x, y),
    applyMask(color.g, size, x + 1.0, y),
    applyMask(color.b, size, x + 2.0, y),
    applyMask(color.a, size, x + 3.0, y)
  ) / 255.0;
}
