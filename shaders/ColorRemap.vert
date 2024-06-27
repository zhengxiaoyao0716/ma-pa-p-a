#version 300 es
precision highp float;

layout (location = 0) in vec2 vertex;
out vec2 uv;

uniform vec4 trans;

void main() {
  vec2 pos = 0.5 * vertex + vec2(0.5);
  uv = pos * trans.zw;
  gl_Position = vec4(vertex, 0.0, 1.0);
}
