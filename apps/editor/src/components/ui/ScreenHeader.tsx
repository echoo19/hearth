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
import React, { useEffect, useRef } from 'react';
import { Icon } from '../ui';

/**
 * What a global screen's way out is called.
 *
 * Skills and Tester both belong to the person and can be reached from either
 * side of the app, so neither of them knows what is waiting underneath until
 * it looks: the project you were reading, or the conversations you were in.
 * One rule in one place, because two screens ask it and a "Back" on one beside
 * a project's name on the other is the app describing the same gesture in two
 * voices.
 *
 * Never the bare word "Back": a way out is only useful if it says where it
 * comes out. And never a place the app does not have — with no folder open,
 * leaving lands on the blank surface, which this app calls New chat (Home and
 * New chat are the same screen, see components/home/Home.tsx). It used to say
 * "Chats", which is a list in the rail and not a screen anyone can be sent to.
 *
 * Pure, so the rule is checkable without a screen.
 */
export function screenBackLabel(projectName: string | null, projectPath: string | null): string {
  return projectPath !== null && projectName !== null && projectName !== '' ? projectName : 'New chat';
}

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
  const heading = useRef<HTMLHeadingElement>(null);

  // On arrival, once. The title changing within one screen is not a new place
  // and must not steal focus from whatever the person is doing on it.
  useEffect(() => {
    heading.current?.focus();
  }, []);

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
      {title !== undefined && (
        // Focus lands here when the screen arrives. Without it, opening Skills
        // or Tester replaced the entire working area while focus stayed on the
        // rail button that was pressed, so a screen reader read nothing and a
        // keyboard user's next Tab continued through the rail as if nothing
        // had happened. A page in a single-page app still has to arrive.
        //
        // tabIndex -1 so it can take focus programmatically without becoming a
        // stop in the tab order: it is a heading, not a control.
        <h1 ref={heading} className="screen-head-title" tabIndex={-1}>
          {title}
        </h1>
      )}
      <div className="screen-head-actions">{actions}</div>
    </header>
  );
}
