// Copy for the two dead-end pages, and the rule that decides who sees a page at all.
//
// Both pages are shells/not-found.html. One shell means one card: an operator's logo, accent
// and footer land on the expired page the same way they land on the missing one, and there is
// only one set of styles to keep in step.
//
// The Accept split: a person following a link sends `text/html` in Accept, and a browser sends
// it only for a navigation. curl, fetch(), an <img>, a <script> and a range read all send
// `*/*` or a media type instead, so they keep the one-line body they have always had. That is
// the line between "a viewer landed here" and "a machine read this".

export const NOT_FOUND_COPY = {
  DOC_TITLE: 'Artifact unavailable',
  STATUS: '404',
  HEADING: 'Artifact unavailable',
  MESSAGE: 'This link may be wrong, disabled, or no longer available. Check the link or ask its sender.',
};

export const EXPIRED_COPY = {
  DOC_TITLE: 'Artifact expired',
  STATUS: '410',
  HEADING: 'Artifact expired',
  MESSAGE: 'This artifact was published with an expiry date and that date has passed. Ask whoever sent it for a fresh link.',
};

// The plain bodies, unchanged, for everything that is not a browser navigation.
export const NOT_FOUND_TEXT = 'not found';
export const EXPIRED_TEXT = 'artifact expired';

export function wantsHtmlPage(acceptHeader) {
  return String(acceptHeader || '').includes('text/html');
}
