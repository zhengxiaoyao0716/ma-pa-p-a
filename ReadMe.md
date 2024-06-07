# MaPaPA

> Magic Palette for Pixel Arts  
> [中文 ReadMe](.docs/ReadMe-zh.md)

## Try it online:

- [Github Page](https://zhengxiaoyao0716.github.io/ma-pa-p-a/)

- [With example image](https://zhengxiaoyao0716.github.io/ma-pa-p-a/?fetch=https://raw.githubusercontent.com/zhengxiaoyao0716/ma-pa-p-a/main/.docs/example.png)
  > Thanks for [Analog studios](https://itch.io/c/1507436/fantasy-)

## Usage

Usage 1. Traditional (style+html+script)

```html
<link rel="stylesheet" href="./ma-pa-p-a.css" />
<div class="mppa dark"></div>
<script>
  import("./ma-pa-p-a.js").then(({ App, render }) => render(new App()));
</script>
```

Usage 2. Inject Style (script-only)

```html
<script>
  import("./ma-pa-p-a.js").then(({ App, inject }) =>
    document.body.appendChild(inject(new App(), { theme: "dark" }))
  );
</script>
```

Usage 3. Web Components (shadow-dom)

```html
<script>
  import("./ma-pa-p-a.js").then(({ init }) => init());
</script>
<ma-pa-p-a theme="dark"></ma-pa-p-a>
```
