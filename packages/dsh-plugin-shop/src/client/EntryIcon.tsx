import { useState, type ReactNode } from 'react'
import css from './ShopTab.module.css'

/** The artwork an entry without a usable icon draws: dsh's own default,
 * `PluginArtworkDefault` from `dsh-client-ui-primitives` (MIT, DeepSeek — see
 * the dsh repository's LICENSE). Copied rather than imported because
 * 0.1.5-rc.3 exports nothing this build could borrow at run time.
 *
 * A constant data URL drawn through an `<img>`, not inline markup: the SVG
 * carries a gradient addressed by id, so thousands of inline copies would each
 * need one, while an image document is its own namespace and needs none
 * (design 2026-10-23-shop-plugin-icons §8.1). The id inside this string is
 * fixed for the same reason.
 */
export const DEFAULT_ICON_DATA_URL = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzYiIGhlaWdodD0iMzYiIHZpZXdCb3g9IjAgMCAzNiAzNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMjQuNjI5NCA4LjYzNjk2QzI2LjI4NjIgOC42MzcwNSAyNy42Mjk0IDkuOTgwMTYgMjcuNjI5NCAxMS42MzdWMTIuNzgyNUMyNy42MjkyIDE0LjQzOTEgMjYuMjg2MSAxNS43ODI0IDI0LjYyOTQgMTUuNzgyNUgyMy40ODM5QzIyLjY1MTkgMTUuNzgyNSAyMS41NDU0IDE2LjM0NTkgMjEuNTQ1NCAxNy4xNzc4VjE4LjE1NzNDMjEuNTQ1NCAxOC43NzU3IDIyLjIxNiAxOS4xOTY2IDIyLjgzNDUgMTkuMTk2NUgyNC42Mjk0QzI2LjI4NjEgMTkuMTk2NSAyNy42MjkyIDIwLjUzOTggMjcuNjI5NCAyMi4xOTY1VjIzLjk5MjRDMjcuNjI5MiAyNS42NDkxIDI2LjI4NjEgMjYuOTkyNCAyNC42Mjk0IDI2Ljk5MjRIMjIuODM0NUMyMS4xNzc4IDI2Ljk5MjQgMTkuODM0NyAyNS42NDkgMTkuODM0NSAyMy45OTI0VjIyLjE5NjVDMTkuODM0NSAyMS43MTQ4IDE5LjQ5NTcgMjEuMjMyNyAxOS4wMTQgMjEuMjMyN0gxNi40NzkyQzE1Ljc5NzUgMjEuMjMyNyAxNS4zMzc0IDIyLjAwNjEgMTUuMzM3NCAyMi42ODc3VjIzLjgzMzNDMTUuMzM3MyAyNS40OSAxMy45OTQyIDI2LjgzMzMgMTIuMzM3NCAyNi44MzMzSDExLjE5MTlDOS41MzUwOSAyNi44MzMzIDguMTkxOTggMjUuNDkgOC4xOTE4OSAyMy44MzMzVjIyLjY4NzdDOC4xOTE4OSAyMS4wMzA5IDkuNTM1MDQgMTkuNjg3NyAxMS4xOTE5IDE5LjY4NzdIMTIuMzM3NEMxMy4xOTY0IDE5LjY4NzcgMTQuMzk5OSAxOS4wOTU5IDE0LjM5OTkgMTguMjM2OVYxNi4wMTg1QzE0LjM5OTkgMTQuOTUxOCAxNS4yNjQ2IDE0LjA4NzIgMTYuMzMxMiAxNC4wODcySDE5LjQzNUMyMC4wNTk2IDE0LjA4NzIgMjAuNDg0IDEzLjQwNzEgMjAuNDgzOSAxMi43ODI1VjExLjYzN0MyMC40ODM5IDkuOTgwMTEgMjEuODI3IDguNjM2OTYgMjMuNDgzOSA4LjYzNjk2SDI0LjYyOTRaTTEzLjQxMTYgMTEuMjQ2OEMxMy40MTE2IDEyLjY4ODIgMTIuMjQzMSAxMy44NTY3IDEwLjgwMTggMTMuODU2N0M5LjM2MDM3IDEzLjg1NjcgOC4xOTE4OSAxMi42ODgyIDguMTkxODkgMTEuMjQ2OEM4LjE5MTg5IDkuODA1NDQgOS4zNjAzNyA4LjYzNjk2IDEwLjgwMTggOC42MzY5NkMxMi4yNDMxIDguNjM2OTYgMTMuNDExNiA5LjgwNTQ0IDEzLjQxMTYgMTEuMjQ2OFoiIGZpbGw9InVybCgjYSkiLz48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIxNS4xNDgxIiB5MT0iOS45NDE4OCIgeDI9IjE1LjE0ODEiIHkyPSIxMy42Mzc1IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzU0RUNFNyIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzY1OEVGRiIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvc3ZnPg=='


/** One entry's icon: a 32px tile holding a 24px image (design §8.3).
 *
 * An author's icon reaches the DOM only here, as this `<img>`'s `src` — a
 * `data:` URL built from bytes the catalog carried. Never `innerHTML`, never
 * an inline `<svg>`: an image document runs no script and loads nothing
 * external, and that is the whole defence for an SVG (§8.5).
 *
 * `onError` swaps a source that will not decode for the default, as dsh's own
 * `PackageArtwork` does. The failed source, not a boolean, is remembered, so a
 * later entry reusing this component instance still tries its own icon.
 */
export function EntryIcon({ icon }: { icon: string | undefined }): ReactNode {
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const src = icon === undefined || icon === failed ? DEFAULT_ICON_DATA_URL : icon
  return (
    <span className={css.entryIcon} aria-hidden="true">
      <img
        className={css.entryIconImage}
        src={src}
        width={24}
        height={24}
        alt=""
        onError={() => { setFailed(icon) }}
      />
    </span>
  )
}
