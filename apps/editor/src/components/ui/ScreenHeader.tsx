/**
 * The strip at the top of a full screen: how you got here, and how you leave.
 *
 * Screens are places, not dialogs. A dialog is dismissed — one Escape, one X,
 * and whatever it was covering comes back. A place is left, which means there
 * has to be a way back that says where back IS. So the button carries a label
 * ("Skills", "Chats") rather than a bare chevron, and the centre names the
 * screen you are standing in.
 *
 * Three slots because that is the shape every screen turned out to want:
 * leaving on the left, the name in the middle, and whatever this screen's
 * primary act is on the right. When there is no act the right slot still
 * reserves its width, so the title stays centred rather than drifting as the
 * screen's state changes.
 */
import React from 'react';
import { Icon } from '../ui';

export function ScreenHeader({
  back,
  title,
  actions,
}: {
  /** Where leaving goes. `label` is the destination, not the gesture. */
  back?: { label: string; onBack: () => void };
  title?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="screen-head">
      <div className="screen-head-lead">
        {back && (
          <button type="button" className="screen-back" onClick={back.onBack}>
            <Icon name="chevron" size={13} />
            {back.label}
          </button>
        )}
      </div>
      {title !== undefined && <h1 className="screen-head-title">{title}</h1>}
      <div className="screen-head-actions">{actions}</div>
    </header>
  );
}
