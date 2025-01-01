import { msg } from '@lit/localize';
import { css, html, LitElement, TemplateResult } from 'lit';
import { property, query } from 'lit/decorators.js';

import '@material/mwc-button';
import '@material/mwc-dialog';
import '@material/mwc-formfield';
import '@material/mwc-switch';

import type { Dialog } from '@material/mwc-dialog';
import type { Switch } from '@material/mwc-switch';
import { EditEvent, isUpdate, newEditEvent } from '@openscd/open-scd-core';

import { subscribe, unsubscribe } from '@openenergytools/scl-lib';
import {
  findControlBlock,
  findFCDAs,
  isSubscribed,
} from './foundation/subscription/subscription.js';

/**
 * Return n siblings of an element.
 * @param element - an Element
 * @param n - number of siblings to return
 * @returns - An element array of siblings
 */
function getNextSiblings(element: Element, n: number): Element[] {
  const siblings = [];
  for (let i = 0; i < n; i += 1) {
    if (element.nextElementSibling) {
      siblings.push(element.nextElementSibling);
      // eslint-disable-next-line no-param-reassign
      element = element.nextElementSibling;
    } else {
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
    // subscription status must be the same after first ExtRef for a match
    const subscriptionStatus = isSubscribed(extRef) || idx === 0;

    if (extRefIntAddr !== null && extRefLnClass !== null) {
      const fcdaIntAddr = `${fcda.getAttribute('doName')};${fcda.getAttribute(
        'lnClass'
      )}/${fcda.getAttribute('doName')}/${fcda.getAttribute('daName')}`;

      if (
        extRefIntAddr === fcdaIntAddr &&
        extRefLnClass === fcda.getAttribute('lnClass') &&
        (isSubscribed(extRef) || idx === 0) === subscriptionStatus
      ) {
        matchedPairs.push([fcda, extRef]);
      }
    }
  }

  return matchedPairs;
}

function shouldListen(event: Event): boolean {
  const initiatingTarget = <Element>event.composedPath()[0];
  return (
    initiatingTarget instanceof Element &&
    initiatingTarget.getAttribute('identity') ===
      'danyill.oscd-subscriber-later-binding' &&
    initiatingTarget.hasAttribute('allowexternalplugins')
  );
}

function parseExtRefIntAddr(extRef: Element): {
  name: string;
  lN: string | undefined;
  dOParts: string;
  dAParts: string;
} | null {
  const intAddr = extRef.getAttribute('intAddr');
  // e.g. RxTapChg1;ATCC/TapChg/valWTr.posVal
  if (intAddr === null) return null;
  const parts = intAddr.split(';');
  if (parts.length !== 2) return null;

  const [name, remainder] = parts;
  const pathParts = remainder.split('/');
  let lN;
  let dOParts;
  let dAParts;

  if (pathParts.length === 3) {
    [lN, dOParts, dAParts] = pathParts;
  } else if (pathParts.length === 2) {
    [lN, dOParts, dAParts] = [undefined, ...pathParts];
  } else {
    return null;
  }
  return { name, lN, dOParts, dAParts };
}

function findMatchingQualityFCDA(fcda: Element): Element | null | undefined {
  if (!fcda.parentElement) return null;

  return Array.from(fcda.parentElement.getElementsByTagName('FCDA')).find(
    candidateFcda =>
      candidateFcda.getAttribute('ldInst') === fcda.getAttribute('ldInst') &&
      candidateFcda.getAttribute('prefix') === fcda.getAttribute('prefix') &&
      candidateFcda.getAttribute('lnClass') === fcda.getAttribute('lnClass') &&
      candidateFcda.getAttribute('lnInst') === fcda.getAttribute('lnInst') &&
      candidateFcda.getAttribute('doName') === fcda.getAttribute('doName') &&
      candidateFcda.getAttribute('daName') === 'q'
  );
}

function findMatchingQualityExtRef(
  extRef: Element
): Element | null | undefined {
  if (!extRef.parentElement) return null;

  const parsedIntAddr = parseExtRefIntAddr(extRef);
  if (!parsedIntAddr) return null;

  const { name, lN, dOParts } = parsedIntAddr;

  // Get all ExtRef elements in the same Inputs element
  return Array.from(extRef.parentElement.getElementsByTagName('ExtRef')).find(
    candidateExtRef => {
      const parsedCandidate = parseExtRefIntAddr(candidateExtRef);
      if (!parsedCandidate) return false;

      return (
        parsedCandidate.name === name &&
        parsedCandidate.lN === lN &&
        parsedCandidate.dOParts === dOParts &&
        parsedCandidate.dAParts === 'q'
      );
    }
  );
}

export default class SubscriberLaterBindingSiemens extends LitElement {
  /** The document being edited as provided to plugins by [[`OpenSCD`]]. */
  @property({ attribute: false })
  doc!: XMLDocument;

  @property({ attribute: false })
  docName!: string;

  preEventExtRef: (Element | null)[] = [];

  ignoreSupervision: boolean = false;

  checkOnlyPreferredBasicType: boolean = false;

  @query('#dialog') dialogUI?: Dialog;

  @query('#enabled') enabledUI?: Switch;

  @property({ attribute: false })
  enabled: boolean =
    localStorage.getItem('oscd-subscriber-lb-siemens') === 'true';

  constructor() {
    super();

    // record information to capture intention
    window.addEventListener(
      'oscd-edit',
      event => this.captureMetadata(event as EditEvent),
      { capture: true }
    );

    window.addEventListener('oscd-edit', event => {
      if (shouldListen(event)) this.modifyAdditionalExtRefs(event as EditEvent);
    });
  }

  async run(): Promise<void> {
    if (this.dialogUI) this.dialogUI.show();
  }

  /**
   * This method records the ExtRefs prior to the EditEvent and
   * also records whether supervisions can be changed for later
   * processing.
   * @param event - An EditEvent.
   */
  protected captureMetadata(event: EditEvent): void {
    if (shouldListen(event)) {
      const initiatingTarget = <Element>event.composedPath()[0];
      // is the later binding subscriber plugin allowing supervisions
      this.ignoreSupervision =
        initiatingTarget.hasAttribute('ignoresupervision') ?? false;
      this.checkOnlyPreferredBasicType =
        initiatingTarget.hasAttribute('checkonlypreferredbasictype') ?? false;

      // Infinity as 1 due to error type instantiation error
      // https://github.com/microsoft/TypeScript/issues/49280
      const flatEdits = [event.detail].flat(Infinity as 1);

      this.preEventExtRef = flatEdits.map(edit => {
        if (isUpdate(edit) && edit.element.tagName === 'ExtRef')
          return this.doc.importNode(edit.element, true);
        return null;
      });
    }
  }

  /**
   * Assess ExtRef for being associate with GOOSE value/quality and
   * dispatch subscribe or unsubscribe events.
   *
   * @param extRef - an ExtRef subject to subscribe/unsubscribe.
   * @param preEventExtRef - an ExtRef subject to subscribe/unsubscribe.
   * but prior to the event.
   * @param fcda - the matching FCDA to the first ExtRef.
   * @returns
   */
  protected modifyValueAndQualityPair(
    extRef: Element,
    preEventExtRef: Element | null,
    fcda: Element
  ): void {
    const controlBlock = findControlBlock(extRef);

    const qualityFcda = findMatchingQualityFCDA(fcda);
    const qualityExtRef = findMatchingQualityExtRef(extRef);

    if (!qualityFcda || !qualityExtRef) return;

    const wasSubscribed = preEventExtRef && isSubscribed(preEventExtRef);

    if (!wasSubscribed && isSubscribed(extRef) && controlBlock)
      this.dispatchEvent(
        newEditEvent(
          subscribe(
            {
              sink: qualityExtRef,
              source: { fcda: qualityFcda, controlBlock },
            },
            {
              force: false,
              ignoreSupervision: false,
              checkOnlyBType: this.checkOnlyPreferredBasicType,
            }
          )
        )
      );

    if (wasSubscribed && !isSubscribed(extRef))
      this.dispatchEvent(newEditEvent(unsubscribe([qualityExtRef])));
  }

  /**
   * Assess ExtRef for being associate with SV traffic and dispatch
   * subscribe or unsubscribe events.
   *
   * @param firstExtRef - an ExtRef subject to subscribe/unsubscribe
   * @param preEventExtRef - an ExtRef subject to subscribe/unsubscribe
   * but prior to the evnet.
   * @param firstFcda - the matching FCDA to the first ExtRef.
   * @returns
   */
  protected modifySampledValueExtRefs(
    firstExtRef: Element,
    preEventExtRef: Element | null,
    firstFcda: Element
  ): void {
    const numberOfSvs = svOrderedFCDAs(firstFcda);
    // 2 consecutive matches required to process SV traffic further otherwise
    // use value/quality matching
    if (!(numberOfSvs > 2)) return;

    const controlBlock = findControlBlock(firstExtRef);
    const wasSubscribed = preEventExtRef && isSubscribed(preEventExtRef);
    // In SIPROTEC 5, phases are within consecutive logical nodes within
    // the same logical device
    const svExtRefs = Array.from(
      firstExtRef.closest('LDevice')!.querySelectorAll('ExtRef')
    )
      .filter(
        compareExtRef =>
          firstExtRef.compareDocumentPosition(compareExtRef) !==
          Node.DOCUMENT_POSITION_PRECEDING
      )
      .slice(0, numberOfSvs);
    const svFCDAs = [firstFcda, ...getNextSiblings(firstFcda, numberOfSvs - 1)];

    // FCDAs are matched to ExtRefs
    matchFCDAsToExtRefs(svFCDAs, svExtRefs).forEach(matchedPair => {
      const mFcda = matchedPair[0];
      const mExtRef = matchedPair[1];
      // TODO: Refactor to multiple connections
      if (!wasSubscribed && isSubscribed(firstExtRef) && controlBlock)
        this.dispatchEvent(
          newEditEvent(
            subscribe({
              sink: mExtRef,
              source: { fcda: mFcda, controlBlock },
            })
          )
        );

      if (wasSubscribed && !isSubscribed(firstExtRef))
        this.dispatchEvent(
          newEditEvent(
            unsubscribe([mExtRef], {
              ignoreSupervision: this.ignoreSupervision,
            })
          )
        );
    });
  }

  /**
   * Will generate and dispatch further EditEvents based on matching an
   * ExtRef with subsequent ExtRefs and the first FCDA with subsequent
   * FCDAs. Uses both `extRef` and `preEventExtRef` to ensure subscription
   * information is available for unsubscribe edits.
   * @param extRef - an SCL ExtRef element
   * @param preEventExtRef - an SCL ExtRef element cloned before changes
   * @returns
   */
  protected processSiemensExtRef(
    extRef: Element,
    preEventExtRef: Element | null
  ) {
    // look for change in subscription pre and post-event
    if (
      !isSubscribed(extRef) &&
      preEventExtRef &&
      !isSubscribed(preEventExtRef)
    )
      return;

    const fcdas = isSubscribed(extRef)
      ? findFCDAs(extRef)
      : findFCDAs(preEventExtRef!);

    let firstFcda: Element | undefined;
    // eslint-disable-next-line prefer-destructuring
    if (fcdas) firstFcda = fcdas[0];

    // must be able to locate the first fcda to continue
    if (!firstFcda) return;

    // If we have a SV stream do as many matching subscriptions as possible
    this.modifySampledValueExtRefs(extRef, preEventExtRef, firstFcda);

    // If we have a value/quality pair do that
    this.modifyValueAndQualityPair(extRef, preEventExtRef, firstFcda);
  }

  /**
   * Either subscribe or unsubscribe from additional ExtRefs adjacent
   * to any ExtRefs found within an event if conditions are met for
   * manufacturer and event type.
   *
   * Assumes that all adding and removing of subscriptions is done
   * through Update edits of ExtRef elements.
   *
   * Only looks at IEDs whose manufacturer is "SIEMENS"
   *
   * @param event - An open-scd-core EditEvent
   * @returns nothing.
   */
  protected modifyAdditionalExtRefs(event: EditEvent): void {
    if (!this.enabled) return;

    // Infinity as 1 due to error type instantiation error
    // https://github.com/microsoft/TypeScript/issues/49280
    const flatEdits = [event.detail].flat(Infinity as 1);

    flatEdits.forEach((edit, index) => {
      if (
        isUpdate(edit) &&
        edit.element.tagName === 'ExtRef' &&
        edit.element?.closest('IED')?.getAttribute('manufacturer') === 'SIEMENS'
      ) {
        this.processSiemensExtRef(edit.element, this.preEventExtRef[index]);
      }
    });

    // restore pre-event cached data
    this.preEventExtRef = [];
    this.ignoreSupervision = false;
  }

  // TODO: Update URL when subscriber later binding is shepherded by OpenSCD organisation
  render(): TemplateResult {
    return html`<mwc-dialog
      id="dialog"
      heading="${msg('Subscriber Later Binding - Siemens')}"
    >
      <p>${msg('This plugin works with the')}
        <a
          href="https://github.com/danyill/oscd-subscriber-later-binding"
          target="_blank"
          >Subscriber Later Binding plugin</a
        >
        ${msg('to provide enhancements for SIPROTEC 5 devices:')}
        <ul>
          <li>${msg('Automatic quality mapping')}</li>
          <li>${msg('Automatic multi-phase mapping')}</li>
        </ul>
        ${msg('for subscribing and unsubscribing.')}
      </p>
      <mwc-formfield label="${msg('Enabled')}">
        <!-- TODO: Remove ?checked when open-scd uses later version of mwc-components -->
        <mwc-switch id="enabled" ?selected=${this.enabled} ?checked=${
      this.enabled
    }>
        </mwc-switch>
      </mwc-formfield>
      <mwc-button
        label="${msg('Close')}"
        slot="primaryAction"
        icon="done"
        @click="${() => {
          // TODO: Remove when open-scd uses later version of mwc-components.
          this.enabled =
            this.enabledUI!.selected ?? (<any>this.enabledUI!).checked ?? false;
          localStorage.setItem('oscd-subscriber-lb-siemens', `${this.enabled}`);
          if (this.dialogUI) this.dialogUI.close();
        }}"
      ></mwc-button>
    </mwc-dialog>`;
  }

  static styles = css`
    mwc-formfield {
      float: right;
    }
  `;
}
