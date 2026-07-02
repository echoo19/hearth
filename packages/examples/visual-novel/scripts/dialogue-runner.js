/**
 * Dialogue: shows params.lines one at a time; "action" advances.
 * Attached to the entity that has the dialogue Text component.
 */
export default {
  onStart(ctx) {
    ctx.vars.index = 0;
    ctx.vars.lines = Array.isArray(ctx.params.lines) && ctx.params.lines.length > 0
      ? ctx.params.lines
      : ['...'];
    ctx.getComponent('Text').content = ctx.vars.lines[0] + '  [E to continue]';
  },

  onUpdate(ctx) {
    if (!ctx.input.justPressed('action')) return;
    if (ctx.vars.index >= ctx.vars.lines.length - 1) return;
    ctx.vars.index += 1;
    const last = ctx.vars.index === ctx.vars.lines.length - 1;
    ctx.getComponent('Text').content =
      ctx.vars.lines[ctx.vars.index] + (last ? '' : '  [E to continue]');
    ctx.log('advanced to line ' + ctx.vars.index);
  },
};
