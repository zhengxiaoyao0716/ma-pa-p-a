# MaPaPA

> Magic Palette for Pixel Arts  
> [中文](.docs/ReadMe-zh.md)

## Usage

Usage 1. Traditional

```html
<link rel="stylesheet" href="./ma-pa-p-a.css" />
<div class="mppa dark"></div>
<script>
  import("./ma-pa-p-a.js").then(({ App, render }) => render(new App()));
</script>
```

Usage 2. Inject Style

```html
<script>
  import("./ma-pa-p-a.js").then(({ App, inject }) =>
    document.body.appendChild(inject(new App(), { theme: "dark" }))
  );
</script>
```

Usage 3. Web Components

```html
<script>
  import("./ma-pa-p-a.js").then(({ init }) => init());
</script>
<ma-pa-p-a theme="dark"></ma-pa-p-a>
```
