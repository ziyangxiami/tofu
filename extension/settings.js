export const SERVICE_SETTINGS = {
    'service.debug': false,
    'service.requestInterval': 1000,
    'service.cloudinary': '',
};

export const TASK_FILES_SETTINGS = {'同步图片.cloudName': ''};

/**
 * Class Settings
 */
export default class Settings {
    static apply(target, settings) {
        for (let key in settings) {
            try {
                let keyPath = key.split('.');
                if (keyPath.shift() !== target.name) {
                    continue;
                }
                let lastNode = keyPath.pop();
                let receiver = target;
                for (let node of keyPath) {
                    receiver = receiver[node];
                }
                receiver[lastNode] = settings[key];
            } catch (e) {
                console.error(e)
            }
        }
    }

    static async load(...args) {
        args.unshift({});
        let defaults = Object.assign.apply(null, args);
        let settings = await new Promise((resolve, reject) => {
            chrome.storage.sync.get(Object.keys(defaults), values => {
                const error = chrome.runtime?.lastError;
                if (error) reject(new Error(error.message)); else resolve(values);
            });
        });
        return Object.assign({}, defaults, settings);
    }

    static async save(settings) {
        return await new Promise((resolve, reject) => {
            chrome.storage.sync.set(settings, () => {
                const error = chrome.runtime?.lastError;
                if (error) reject(new Error(error.message)); else resolve();
            });
        });
    }
}
