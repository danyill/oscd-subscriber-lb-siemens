import { LitElement, TemplateResult } from 'lit';
import '@material/mwc-button';
import '@material/mwc-dialog';
import '@material/mwc-formfield';
import '@material/mwc-switch';
import type { Dialog } from '@material/mwc-dialog';
import type { Switch } from '@material/mwc-switch';
import { EditEvent, Update } from '@openscd/open-scd-core';
/**
 * Check if the ExtRef is already subscribed to a FCDA Element.
 *
 * @param extRef - The Ext Ref Element to check.
 */
export declare function isSubscribedEv(update: Update): boolean;
export default class SubscriberLaterBindingSiemens extends LitElement {
    /** The document being edited as provided to plugins by [[`OpenSCD`]]. */
    doc: XMLDocument;
    docName: string;
    preEventExtRef: (Element | null)[];
    dialogUI?: Dialog;
    enabledUI?: Switch;
    enabled: boolean;
    constructor();
    run(): Promise<void>;
    protected captureMetadata(event: EditEvent): void;
    protected processSiemensExtRef(extRef: Element, preEventExtRef: Element | null): void;
    protected modifyAdditionalExtRefs(event: EditEvent): void;
    render(): TemplateResult;
}
