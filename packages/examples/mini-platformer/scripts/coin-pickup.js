/**
 * Coin: when the player touches it, bump the Score text and disappear.
 */
export default {
  onCollision(ctx, other) {
    if (!other.tags.includes('player')) return;
    const score = ctx.scene.find('Score');
    if (score) {
      const text = score.getComponent('Text');
      const current = parseInt((text.content.match(/\d+/) || ['0'])[0], 10);
      text.content = 'Score: ' + (current + 1);
    }
    ctx.log('coin collected');
    ctx.destroySelf();
  },
};
