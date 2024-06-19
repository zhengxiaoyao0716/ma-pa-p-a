#version 300 es
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
