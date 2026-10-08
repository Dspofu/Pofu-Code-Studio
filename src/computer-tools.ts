// SPDX-License-Identifier: Apache-2.0

export const imageTools = [{
  type: 'function',
  function: {
    name: 'view_image',
    description: 'Opens a local image inside the workspace and attaches its pixels. Use it to inspect screenshots, icons and design references; read_file does not decode images.',
    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] }
  }
}];

export const computerTools = [{
  type: 'function',
  function: {
    name: 'capture_screen',
    description: 'Captures a real monitor and attaches its image. Returns monitors and a screenshot_id needed for computer_action. Coordinates refer to this image, with (0,0) at its top left.',
    parameters: { type: 'object', properties: { display_id: { type: 'string', description: 'Monitor ID from an earlier capture. Omit for the primary monitor.' } } }
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
