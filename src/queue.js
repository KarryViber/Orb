const MAX_QUEUE = 10;

class TaskQueue {
  constructor(maxSize = MAX_QUEUE) {
    this.maxSize = maxSize;
    this.queue = [];
  }

  enqueue(task) {
    if (this.queue.length >= this.maxSize) return false;
    task.enqueuedAt = Date.now();
    this.queue.push(task);
    return true;
  }

  dequeue() {
    return this.queue.shift() || null;
  }

  get size() {
    return this.queue.length;
  }

  hasThread(threadTs) {
    return this.queue.some((t) => t.threadTs === threadTs);
  }
}

export const taskQueue = new TaskQueue();
