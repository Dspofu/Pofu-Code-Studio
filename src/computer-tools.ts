// SPDX-License-Identifier: Apache-2.0

export const imageTools = [{
  type: 'function',
  function: {
    name: 'view_image',
    description: 'Opens a local image inside the workspace and attaches its pixels. Use it to inspect screenshots, icons and design references; read_file does not decode images.',
    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] }
  }
}, {
  type: 'function',
  function: {
    name: 'view_attachment',
    description: 'Re-opens an image the user attached earlier in this conversation and attaches its pixels. Only recent attachments are resent with each request; use this to look at an older one again. Call without arguments to list them.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'File name as in "[Attached image: NAME]". The most recent match is used.' }, index: { type: 'number', description: '1 = most recent attached image. Use instead of name.' } } }
  }
}];

export const computerTools = [{
  type: 'function',
  function: {
    name: 'capture_screen',
    description: 'Captures a real monitor, or only one program window, and attaches its image. Returns a screenshot_id needed for computer_action. Coordinates refer to this image, with (0,0) at its top left.',
    parameters: { type: 'object', properties: {
      display_id: { type: 'string', description: 'Monitor ID from an earlier capture, or "primary". Omit for the primary monitor.' },
      window: { type: 'string', description: 'Capture only this program window instead of the monitor, even behind other windows: part of its title, the PID returned by execute_command, or a window_id from an earlier capture.' },
      offscreen: { type: 'boolean', description: 'With window: true moves a program you started outside the visible screen, so it runs without covering the user\'s work (it still renders, but takes no clicks); false brings it back.' }
    } }
  }
}, {
  type: 'function',
  function: {
    name: 'computer_action',
    description: 'Controls the Windows desktop using a recent capture_screen screenshot_id. One action per capture; click coordinates are image pixels. Returns a new screenshot after the action. Inspect it before proceeding. Use dedicated file/HTTP tools when possible.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'double_click', 'move', 'scroll', 'key', 'type'] },
        screenshot_id: { type: 'string' },
        x: { type: 'number', description: 'Image x coordinate; required for click, double_click and move.' },
        y: { type: 'number', description: 'Image y coordinate.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction. Also provide x and y over the area to scroll.' },
        amount: { type: 'number', description: 'Scroll steps, 1-10; default 3.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Simultaneous shortcut, e.g. ["CTRL","L"], ["ENTER"], ["ALT","TAB"].' },
        text: { type: 'string', description: 'Literal Unicode text to type, up to 2000 characters.' }
      },
      required: ['action', 'screenshot_id']
    }
  }
}];
