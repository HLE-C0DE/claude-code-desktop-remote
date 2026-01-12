// CDP (Chrome DevTools Protocol) executor for Claude Desktop
// Usage: node cdp-execute.js "javascript code to execute"

const WebSocket = require('ws');
const http = require('http');

async function getDebugTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function executeJS(code) {
    const targets = await getDebugTargets();

    // Find the main Claude page (claude.ai)
    const mainPage = targets.find(t => t.url.includes('claude.ai'));
    if (!mainPage) {
        throw new Error('Claude main page not found');
    }

    console.log('Connecting to:', mainPage.title, '-', mainPage.url);

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(mainPage.webSocketDebuggerUrl);

        ws.on('open', () => {
            const message = {
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                    expression: code,
                    returnByValue: true,
                    awaitPromise: true
                }
            };
            ws.send(JSON.stringify(message));
        });

        ws.on('message', (data) => {
            const response = JSON.parse(data);
            if (response.id === 1) {
                ws.close();
                if (response.error) {
                    reject(new Error(response.error.message));
                } else {
                    resolve(response.result);
                }
            }
        });

        ws.on('error', reject);

        setTimeout(() => {
            ws.close();
            reject(new Error('Timeout'));
        }, 10000);
    });
}

// Main
const code = process.argv[2] || 'Object.keys(window).filter(k => k.includes("claude"))';

executeJS(code)
    .then(result => {
        console.log('\n=== Result ===');
        console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
    });
