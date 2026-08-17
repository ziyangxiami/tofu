/**
 * Class AsyncBlockingQueue
 */
export default class AsyncBlockingQueue {
    constructor() {
        this.items = [];
        this.resolves = [];
    }

    enqueue(item) {
        if (this.resolves.length) {
            this.resolves.shift()(item);
        } else {
            this.items.push(item);
        }
    }

    dequeue() {
        if (this.items.length) {
            return Promise.resolve(this.items.shift());
        }
        return new Promise(resolve => this.resolves.push(resolve));
    }

    isEmpty() {
        return !this.items.length;
    }

    isBlocked() {
        return !!this.resolves.length;
    }

    clear() {
        this.items.length = 0;
    }

    get length() {
        return this.items.length;
    }
}
