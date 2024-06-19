#version 300 es
precision highp int;
precision highp float;

in vec2 uv;
out vec4 fragColor;

uniform sampler2D bitmap;

void main() {
  fragColor = texture(bitmap, uv);
}
