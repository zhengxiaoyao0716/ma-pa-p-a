#version 300 es
precision highp int;
precision highp float;

in vec2 uv;
out vec4 fragColor;

uniform lowp usampler2D dataTex;
uniform sampler2D plteTex;

void main() {
  lowp uint index = texelFetch(dataTex, ivec2(uv), 0).r;
  fragColor = texelFetch(plteTex, ivec2(index, 0), 0);
}
