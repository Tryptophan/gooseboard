import { getSchema, Mark, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import { DOMSerializer, Node as PMNode } from '@tiptap/pm/model'
import { yXmlFragmentToProsemirrorJSON, prosemirrorJSONToYXmlFragment } from 'y-prosemirror'
import type * as Y from 'yjs'

/**
 * Notes saved before heading sizes carry a `textSize` mark in their Yjs document, and a schema
 * without it throws "There is no mark type textSize". Kept only so those notes still load: it
 * renders as a plain span and is never offered in the UI.
 */
const LegacyTextSize = Mark.create({
  name: 'textSize',
  addAttributes: () => ({ size: { default: null, rendered: false } }),
  parseHTML: () => [],
  renderHTML: () => ['span', 0],
})

/**
 * Extensions shared by the live editor and the static renderer.
 *
 * Notes must stay 1:1 with markdown: only add nodes and marks that markdown can express
 * (headings, emphasis, lists, task lists, quotes, code, links). No colours, sizes or
 * alignment, so a note can always be exported to markdown without losing anything.
 *
 * StarterKit's input rules
 * give "markdown as you type" (# heading, **bold**, - list, 1. list, > quote, ``` code).
 * History is off: undo/redo comes from Yjs.
 */
export const noteExtensions: Extensions = [
  StarterKit.configure({ history: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
  LegacyTextSize,
  Link.configure({ openOnClick: true, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } }),
]

export const noteSchema = getSchema(noteExtensions)
const serializer = DOMSerializer.fromSchema(noteSchema)

export function fragmentToJSON(fragment: Y.XmlFragment): any {
  return yXmlFragmentToProsemirrorJSON(fragment)
}

export function jsonToFragment(json: any, fragment: Y.XmlFragment) {
  if (json) prosemirrorJSONToYXmlFragment(noteSchema, json, fragment)
}

export function fragmentToHTML(fragment: Y.XmlFragment): string {
  const json = fragmentToJSON(fragment)
  if (!json || !json.content) return ''
  const doc = PMNode.fromJSON(noteSchema, json)
  const el = document.createElement('div')
  el.appendChild(serializer.serializeFragment(doc.content))
  // peers control the document: never let a link carry a script URL
  el.querySelectorAll('a').forEach((a) => {
    if (!/^(https?:|mailto:)/i.test(a.getAttribute('href') ?? '')) a.removeAttribute('href')
  })
  return el.innerHTML
}

export function fragmentToText(fragment: Y.XmlFragment): string {
  const json = fragmentToJSON(fragment)
  if (!json || !json.content) return ''
  return PMNode.fromJSON(noteSchema, json).textBetween(0, PMNode.fromJSON(noteSchema, json).content.size, '\n')
}

/** Flip the nth task item (document order, matching the rendered <li>s) without opening the editor. */
export function toggleTask(fragment: Y.XmlFragment, index: number) {
  let n = 0
  for (const el of fragment.createTreeWalker((x) => (x as Y.XmlElement).nodeName === 'taskItem')) {
    if (n++ !== index) continue
    const item = el as Y.XmlElement
    item.setAttribute('checked', !item.getAttribute('checked') as any)
    return
  }
}
