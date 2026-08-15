'use strict';
import Task from '../services/Task.js';
import TaskError from '../services/TaskError.js';
import Drafter from '../vendor/draft.js';


const URL_MOCK = 'https://foo.bar/';


export default class Mock extends Task {
    async run() {
        let fetch = await this.fetch
        let response = await fetch(URL_MOCK);
    }

    get name() {
        return 'Mock';
    }
}
