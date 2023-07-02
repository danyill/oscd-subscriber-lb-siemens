import { msg } from '@lit/localize';
import { html, LitElement, TemplateResult } from 'lit';
import { property, query } from 'lit/decorators.js';

import '@material/mwc-button';
import '@material/mwc-dialog';
import '@material/mwc-formfield';
import '@material/mwc-switch';

import type { Dialog } from '@material/mwc-dialog';
import type { Switch } from '@material/mwc-switch';
import {
  EditEvent,
  isUpdate,
  newEditEvent,
  Update,
} from '@openscd/open-scd-core';

import { subscribe } from '@openenergytools/scl-lib';
import {
  findControlBlock,
  findFCDAs,
  isSubscribed,
} from './foundation/subscription/subscription.js';
// import { findFCDAs } from './foundation/subscription/subscription.js';

/**
 * Check if the ExtRef is already subscribed to a FCDA Element.
 *
 * @param extRef - The Ext Ref Element to check.
 */
export function isSubscribedEv(update: Update): boolean {
  return (
    update.element.tagName === 'ExtRef' &&
    ['iedName', 'ldInst', 'lnClass', 'lnInst', 'doName'].every(
      attr => attr in update.attributes
    )
  );
}

const fcdaMatchSiemens = (a: Element, b: Element) =>
  ['ldInst', 'prefix', 'lnClass', 'lnInst', 'doName', 'daName'].every(
    attr =>
      a.getAttribute(attr) === b?.getAttribute(attr) ||
      (attr === 'daName' && b.getAttribute('daName') === 'q') ||
      b.getAttribute('daName')?.split('.').slice(-1)[0] === 'q'
  );

function extRefMatchSiemens(a: Element, b: Element): boolean {
  const aParts = a.getAttribute('intAddr')?.split('/') ?? [];
  const bParts = b.getAttribute('intAddr')?.split('/');
  return (
    JSON.stringify(aParts?.slice(0, aParts.length - 1)) ===
    JSON.stringify(bParts?.slice(0, aParts.length - 1))
  );
}

function getNextSiblings(element: Element, n: number): Element[] {
  const siblings = [];
  // Loop n times
  for (let i = 0; i < n; i += 1) {
    if (element.nextElementSibling) {
      siblings.push(element.nextElementSibling);
      // eslint-disable-next-line no-param-reassign
      element = element.nextElementSibling;
    } else {
      // Break the loop if there are no more siblings
      break;
    }
  }

  return siblings;
}

/**
 * For FCDAs to be an SV stream they must be the same lnClass, the same
 * doName, and functional constraint (fc) and they must alternate between
 * the same value and a data attribute called "q". The FCDAs must be in
 * exact ascending order.
 *
 * Currently this function also restricts that they must be within the
 * same logical device and the inst number must be the same or equal to the
 * previous value.
 *
 * @param firstFcda
 * @returns
 */
function svOrderedFCDAs(firstFcda: Element): number {
  let ldInst: string | null = null;
  let lnClass: string | null = null;
  let doName: string | null = null;
  let daName: string | null = null;
  let inst: number | null = null;
  let count = 0;

  const fcdas = [firstFcda, ...getNextSiblings(firstFcda, 7)];

  for (let i = 0; i < fcdas.length; i += 1) {
    const fcda = fcdas[i];
    const currentLdInst = fcda.getAttribute('ldInst');
    const currentLnClass = fcda.getAttribute('lnClass');
    const currentDoName = fcda.getAttribute('doName');
    const currentDaName = fcda.getAttribute('daName');
    const currentFc = fcda.getAttribute('fc');
    const currentInst = parseInt(fcda.getAttribute('lnInst') || '', 10);

    if (i === 0) {
      ldInst = currentLdInst;
      lnClass = currentLnClass;
      doName = currentDoName;
      daName = currentDaName;
      inst = currentInst;
    }

    if (
      currentLdInst !== ldInst ||
      currentLnClass !== lnClass ||
      currentDoName !== doName ||
      currentFc !== 'MX' ||
      currentInst < inst!
    ) {
      break; // Stop processing further elements
    }

    if (i % 2 === 0) {
      if (currentDaName !== daName) {
        daName = currentDaName; // Update daName on even indices
      }
    } else if (currentDaName !== 'q') {
      break; // Stop processing further elements if odd-indexed daName is not 'q'
    }

    count += 1;
  }

  return count;
}

function matchFCDAsToExtRefs(
  fcdas: Element[],
  extRefs: Element[]
): [Element, Element][] {
  const matchedPairs: [Element, Element][] = [];

  for (let idx = 0; idx < extRefs.length; idx += 1) {
    const fcda = fcdas[idx];
    const extRef = extRefs[idx];

    const extRefIntAddr = extRef.getAttribute('intAddr');
    const extRefLnClass = extRef.closest('LN')!.getAttribute('lnClass');

    if (extRefIntAddr !== null && extRefLnClass !== null) {
      const fcdaIntAddr = `${fcda.getAttribute('doName')};${fcda.getAttribute(
        'lnClass'
      )}/${fcda.getAttribute('doName')}/${fcda.getAttribute('daName')}`;

      if (
        extRefIntAddr === fcdaIntAddr &&
        extRefLnClass === fcda.getAttribute('lnClass') &&
        (!isSubscribed(extRef) || idx === 0)
      ) {
        matchedPairs.push([fcda, extRef]);
      }
    }
  }

  return matchedPairs;
}

export default class SubscriberLaterBindingSiemens extends LitElement {
  /** The document being edited as provided to plugins by [[`OpenSCD`]]. */
  @property({ attribute: false })
  doc!: XMLDocument;

  @property({ attribute: false })
  docName!: string;

  @query('#dialog') dialogUI?: Dialog;

  @query('#enabled') enabledUI?: Switch;

  @property({ attribute: false })
  enabled: boolean =
    localStorage.getItem('oscd-subscriber-lb-siemens') === 'true';

  constructor() {
    super();

    window.addEventListener('oscd-edit', event =>
      this.createAdditionalExtRefs(event as EditEvent)
    );
  }

  async run(): Promise<void> {
    if (this.dialogUI) this.dialogUI.show();
  }

  protected processSiemensExtRef(extRef: Element) {
    const nextExtRef = extRef.nextElementSibling;
    const fcdas = findFCDAs(extRef);
    let fcda: Element | undefined;
    // eslint-disable-next-line prefer-destructuring
    if (fcdas) fcda = fcdas[0];

    if (!nextExtRef || !fcda) return;

    // See if we have a SV stream and if so do that
    const svOrdered = svOrderedFCDAs(fcda);
    if (svOrdered > 2) {
      const svExtRefs = Array.from(
        extRef.closest('LDevice')!.querySelectorAll('ExtRef')
      )
        .slice(0, svOrdered)
        .filter(
          compareExtRef =>
            extRef.compareDocumentPosition(compareExtRef) !==
            Node.DOCUMENT_POSITION_PRECEDING
        );
      const svFCDAs = [fcda, ...getNextSiblings(fcda, svOrdered - 1)];

      const controlBlock = findControlBlock(extRef);

      matchFCDAsToExtRefs(svFCDAs, svExtRefs).forEach(matchedPair => {
        const mFcda = matchedPair[0];
        const mExtRef = matchedPair[1];
        // TODO: Refactor to multiple connections
        this.dispatchEvent(
          newEditEvent(
            subscribe({
              sink: mExtRef,
              source: { fcda: mFcda, controlBlock },
            })
          )
        );
      });
    }

    // Else match value/quality pairs
    const nextFcda = fcda.nextElementSibling;
    const controlBlock = findControlBlock(extRef);

    if (
      extRefMatchSiemens(extRef, nextExtRef) &&
      nextFcda &&
      fcdaMatchSiemens(fcda, nextFcda)
    ) {
      this.dispatchEvent(
        newEditEvent(
          subscribe({
            sink: nextExtRef,
            source: { fcda: nextFcda, controlBlock },
          })
        )
      );
    }
  }

  protected createAdditionalExtRefs(event: EditEvent): void {
    if (!this.enabled) return;

    // Infinity as 1 due to error type instantiation error
    // https://github.com/microsoft/TypeScript/issues/49280
    const flatEdits = [event.detail].flat(Infinity as 1);

    flatEdits.forEach(edit => {
      if (isUpdate(edit) && edit.element.tagName === 'ExtRef') {
        const extRef = edit.element;
        const iedManufacturer = extRef
          ?.closest('IED')
          ?.getAttribute('manufacturer');

        if (
          !(
            extRef &&
            isSubscribed(extRef) &&
            isSubscribedEv(edit) &&
            iedManufacturer === 'SIEMENS'
          )
        )
          return;

        this.processSiemensExtRef(extRef);
      }
    });
  }

  render(): TemplateResult {
    return html`<mwc-dialog
      id="dialog"
      heading="${msg('Subscriber Later Binding - Siemens')}"
    >
      <p>
        ${msg('This plugin works with the')}
        <!-- TODO: Update URL when subscriber later binding is shepherded by OpenSCD organisation -->
        <a
          href="https://github.com/danyill/oscd-subscriber-later-binding"
          target="_blank"
          >Subscriber Later Binding plugin</a
        >
        ${msg('to provide enhancements for SIPROTEC 5 devices.')}
        <ul>
          <li>${msg('Automatic quality mapping')}</li>
          <li>${msg('Automatic multi-phase mapping')}</li>
        </ul>
      </p>
      <mwc-formfield style="float:right" label="${msg('Enabled')}">
        <mwc-switch id="enabled" ?selected=${this.enabled}>
        </mwc-switch>
      </mwc-formfield>
      <mwc-button
        label="${msg('Close')}"
        slot="primaryAction"
        icon="done"
        @click="${() => {
          this.enabled = this.enabledUI!.selected;
          localStorage.setItem('oscd-subscriber-lb-siemens', `${this.enabled}`);
          if (this.dialogUI) this.dialogUI.close();
        }}"
      ></mwc-button>
    </mwc-dialog>`;
  }
}
