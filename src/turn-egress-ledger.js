export class TurnEgressLedger {
  constructor() {
    this.segments = [];
  }

  record(phase, text) {
    if (typeof text !== 'string' || !text) return;
    this.segments.push({
      phase,
      text,
      sentAt: Date.now(),
    });
  }

  computeUndelivered(fullText) {
    const text = typeof fullText === 'string' ? fullText : '';
    if (!text.trim()) return '';

    const deliveredSegments = this.segments
      .map((segment) => typeof segment?.text === 'string' ? segment.text : '')
      .filter((segmentText) => segmentText.trim());
    if (deliveredSegments.length === 0) return text;

    let cursor = 0;
    let remaining = '';
    for (const segmentText of deliveredSegments) {
      const index = text.indexOf(segmentText, cursor);
      if (index < 0) return text;
      const gap = text.slice(cursor, index);
      if (gap.trim()) remaining += gap;
      cursor = index + segmentText.length;
    }
    remaining += text.slice(cursor);

    return remaining.trim() ? remaining : '';
  }

  isAlreadyDelivered(text) {
    return this.computeUndelivered(text) === '';
  }

  reset() {
    this.segments = [];
  }
}
