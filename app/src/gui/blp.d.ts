/**
 * Ambient type for Blueprint imports.
 *
 * `@gjsify/vite-plugin-blueprint` (wired into `gjsify build --app gjs`) compiles each `.blp` with
 * `blueprint-compiler` and emits the GTK Builder XML as the module's default export — a string,
 * which is exactly what `GObject.registerClass({ Template })` accepts. The per-file `.d.blp.ts`
 * sidecars narrow that to the ids the template actually declares; this declaration is only the
 * fallback that keeps a `.blp` without a sidecar type-checking.
 */
declare module '*.blp' {
    const template: string;
    export default template;
}
