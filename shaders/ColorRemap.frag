#version 300 es
precision highp int;
precision highp float;

in vec2 uv;
out vec4 fragColor;

uniform vec4 trans;
uniform bool stack;
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

lowp uint applyMask(int size, float offset) {
  vec2 pos = vec2(uv.x + offset, uv.y);
  lowp uint source = texelFetch(dataTex, ivec2(pos), 0).r;
  lowp uint mapped = texelFetch(mapper, ivec2(source, 0), 0).r;
  if (mapped == 255u) return source;

  vec2 point = pos + trans.xy;
  for (int i = size - 1; i >= 0; i--) {
    uvec4 area = texelFetch(areaTex, ivec2(i, 0), 0);
    if (hasPoint(vec4(area), point.x, point.y)) {
      uint flag = texelFetch(flagTex, ivec2(i >> 3, 0), 0).r;
      bool cutout = (flag & uint(1 << (i & 7))) != 0u;
      return cutout ? source : mapped;
    }
  }
  return source;
}

void main() {
  int size = textureSize(areaTex, 0).x;
  fragColor = stack ? vec4(
    applyMask(size, 0.0),
    applyMask(size, 1.0),
    applyMask(size, 2.0),
    applyMask(size, 3.0)
  ) / 255.0 : vec4(float(applyMask(size, 0.0)) / 255.0);
}
