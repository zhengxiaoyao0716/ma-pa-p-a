#version 300 es
precision highp float;

layout (location = 0) in vec2 vertex;
out vec2 uv;

void main() {
  uv = 0.5 * vertex + vec2(0.5);
  gl_Position = vec4(vertex, 0.0, 1.0);
}
