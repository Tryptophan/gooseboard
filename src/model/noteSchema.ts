import { getSchema, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import { DOMSerializer, Node as PMNode } from '@tiptap/pm/model'
import { yXmlFragmentToProsemirrorJSON, prosemirrorJSONToYXmlFragment } from 'y-prosemirror'
import type * as Y from 'yjs'

/**
 * Extensions shared by the live editor and the static renderer. StarterKit's input rules
 * give "markdown as you type" (# heading, **bold**, - list, 1. list, > quote, ``` code).
 * History is off: undo/redo comes from Yjs.
 */
export const noteExtensions: Extensions = [
  StarterKit.configure({ history: false }),
  TaskList,
  TaskItem.configure({ nested: true }),
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
