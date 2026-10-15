// Run with: node tests/ribbon-theme-browser.test.cjs
// Uses a temporary native Vivaldi profile, native toolbar preferences and all CSS mods.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const binary=process.env.RIBBON_THEME_BROWSER||['/opt/vivaldi-snapshot/vivaldi-bin','/opt/vivaldi/vivaldi-bin'].find(file=>fs.existsSync(file));
if(!binary)throw Error('Vivaldi is required');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivaldi-ribbon-test-'));
    const child = spawn(binary, ['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
    let ws;
    try {
        const endpoint = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('No DevTools endpoint')), 15000);
            child.stderr.on('data', data => {const match = data.toString().match(/DevTools listening on (ws:\/\/\S+)/); if (match) {clearTimeout(timer); resolve(match[1]);}});
            child.on('exit', code => {clearTimeout(timer); reject(Error('Browser exited: '+code));});
        });
        ws = new WebSocket(endpoint); await new Promise((resolve, reject) => {ws.onopen=resolve; ws.onerror=reject;});
        let sequence=0; const pending=new Map();
        ws.onmessage = event => {const msg=JSON.parse(event.data); if (!msg.id) return; const p=pending.get(msg.id); pending.delete(msg.id); if (p) msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result);};
        const call = (method, params={}, sessionId) => new Promise((resolve, reject) => {
            const id=++sequence, timer=setTimeout(() => {pending.delete(id); reject(Error('CDP timeout: '+method));}, 10000);
            pending.set(id, {resolve:r=>{clearTimeout(timer); resolve(r);}, reject:e=>{clearTimeout(timer); reject(e);}});
            ws.send(JSON.stringify({id, method, params, sessionId}));
        });
        const evaluate = async (expression, sessionId) => {
            const result=await call('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true,includeCommandLineAPI:true}, sessionId)
                .catch(error => {throw Error(error.message+' evaluating '+expression.slice(0,160));});
            if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        };
        const until = async (expression, sessionId) => {for (let i=0;i<80;i++) {const value=await evaluate(expression,sessionId); if (value) return value; await delay(100);} throw Error('Timed out: '+expression);};
        await delay(1500);
        const targets=await call('Target.getTargets'),target=targets.targetInfos.find(t=>t.url.endsWith('/window.html'));
        const initial=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
        await evaluate("chrome.storage.local.set({fullScreenModEnabled:false}).then(()=>chrome.windows.create({url:'about:blank',type:'normal'}))",initial.sessionId);
        let testTarget;
        for(let i=0;i<80&&!testTarget;i++){
            testTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/window.html')&&t.targetId!==target.targetId);
            if(!testTarget)await delay(100);
        }
        assert.ok(testTarget,'A fresh native window is required to disable the installed fullscreen mod');
        let {sessionId}=await call('Target.attachToTarget',{targetId:testTarget.targetId,flatten:true});
        const evaluateHere=expression=>evaluate(expression,sessionId), wait=expression=>until(expression,sessionId);
        await wait("!!document.getElementById('browser')&&!!document.getElementById('webview-container')");
        await wait("!document.getElementById('app').classList.contains('fullscreen-listener-enabled')");
        await evaluateHere(`(async()=>{
            await vivaldi.prefs.set({path:'vivaldi.toolbars.navigation',value:[]});
            await vivaldi.prefs.set({path:'vivaldi.toolbars.tabbar_before',value:['Back','Forward','Reload','AddressField']});
        })()`);
        await wait("!!document.querySelector('#tabs-container > .toolbar-tabbar-before .UrlBar-AddressField')");
        const cssDir=path.resolve(__dirname,'..');
        for(const file of fs.readdirSync(cssDir).filter(f=>f.endsWith('.css')).sort())await evaluateHere(`(()=>{const style=document.createElement('style');style.dataset.reviewFile=${JSON.stringify(file)};style.textContent=${JSON.stringify(fs.readFileSync(path.join(cssDir,file),'utf8'))};document.head.append(style);})()`);
        await call('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},sessionId);


        let passed=0;
        const check=async(label,run)=>{await run();passed++;console.log('PASS',label);};
        const pref=(path,value)=>evaluateHere(`vivaldi.prefs.set({path:${JSON.stringify(path)},value:${JSON.stringify(value)}})`);
        await pref('vivaldi.bookmarks.bar.visible',true);
        await pref('vivaldi.theme.schedule.enabled','off');
        await evaluateHere("(async()=>{window.__ribbonThemes=(await vivaldi.prefs.get('vivaldi.themes.system')).value;})()");
        const colors=()=>evaluateHere(`(()=>{
            const rgba=value=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
            const luminance=c=>c.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
            const pairs=[['.UrlBar-AddressField','#urlFieldInput'],['.tab.active','.tab.active .title'],['#switch','#switch .button-toolbar > button'],['.toolbar-statusbar','.toolbar-statusbar .button-toolbar > button'],['.toolbar-statusbar','.toolbar-statusbar .button-title'],['.bookmark-bar .observer','.bookmark-bar .observer button']];
            return pairs.map(([surface,content])=>{const bgEl=document.querySelector(surface),fgEl=document.querySelector(content);if(!bgEl||!fgEl)return {surface,content,missing:true};
                const bg=getComputedStyle(bgEl).backgroundColor,fg=getComputedStyle(fgEl).color,b=rgba(bg),f=rgba(fg);
                return {surface,content,bg,fg,opaque:b[3]===255,contrast:(Math.max(luminance(b),luminance(f))+.05)/(Math.min(luminance(b),luminance(f))+.05)};
            });
        })()`);
        const checkColors=async()=>{
            for(const result of await colors()){
                assert.ok(!result.missing,`Native content must exist: ${result.content}`);
                assert.ok(result.opaque,`Ribbon background must remain opaque: ${result.surface}`);
                assert.ok(result.contrast>=4.5,`Readable ${result.content} on ${result.surface}: ${JSON.stringify(result)}`);
            }
        };
        for(const id of ['Vivaldi1','Vivaldi2','VivaldiZen','VivaldiForest']){
            await check(`readable native theme ${id}`,async()=>{
                await evaluateHere(`vivaldi.prefs.set({path:'vivaldi.themes.preview',value:[{...__ribbonThemes.find(t=>t.id==='${id}'),accentFromPage:false}]})`);
                await delay(650);await checkColors();
            });
        }
        for(const accent of ['#000000','#202020','#222222','#808080','#b0b0b0','#ffffff']){
            await check(`readable mixed accent ${accent}`,async()=>{
                await evaluateHere(`vivaldi.prefs.set({path:'vivaldi.themes.preview',value:[{...__ribbonThemes[0],id:'RibbonTest',accentFromPage:false,colorAccentBg:'${accent}'}]})`);
                await delay(650);await checkColors();
            });
        }
        await pref('vivaldi.themes.preview',[]);await delay(650);
        const motion=()=>evaluateHere(`(()=>{
            const selectors=['#browser','#header','#tabs-tabbar-container','#main','#panels-container','#switch','#webpage-stack','.tab.active','.DomainButton','.bookmark-bar','footer'];
            return selectors.map(selector=>{const el=document.querySelector(selector);const s=el&&getComputedStyle(el);return {selector,duration:s?.transitionDuration};});
        })()`);
        const assertNoMotion=async()=>{for(const s of await motion())assert.ok(s.duration&&s.duration.split(',').every(v=>parseFloat(v)===0),`${s.selector} must respect motion settings: ${s.duration}`);
            const field=await evaluateHere("(()=>{const s=getComputedStyle(document.querySelector('.UrlBar-AddressField'));return {properties:s.transitionProperty.split(',').map(v=>v.trim()),durations:s.transitionDuration.split(',').map(v=>parseFloat(v))};})()");
            for(const property of ['background-color','color'])assert.equal(field.durations[field.properties.indexOf(property)],0,`Merged field ${property} must respect motion settings`);
        };
        await check('Vivaldi animation setting disables Ribbon color transitions',async()=>{
            await pref('vivaldi.theme.use_animation',false);await wait("document.getElementById('browser').classList.contains('animation-off')");await assertNoMotion();
            await pref('vivaldi.theme.use_animation',true);await wait("!document.getElementById('browser').classList.contains('animation-off')");
        });
        await check('system reduced-motion preference disables Ribbon color transitions',async()=>{
            await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);await assertNoMotion();
            await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sessionId);
        });
        await check('color transitions resume when animations are enabled',async()=>{
            assert.ok((await motion()).find(s=>s.selector==='#switch').duration.split(',').every(v=>parseFloat(v)===.5));
        });
        await pref('vivaldi.tabs.stacking.auto_editor',false);await pref('vivaldi.tabs.stacking.mode','dotted');
        await evaluateHere(`(async()=>{const tabs=[];for(let i=0;i<3;i++)tabs.push(await chrome.tabs.create({windowId:vivaldiWindowId,url:'about:blank#ribbon-'+i,active:true}));return vivaldi.tabsPrivate.move({tabIds:tabs.map(t=>t.id),target:tabs[0].id,tweaks:['do-not-reparent','create-new-group'],debug:'Ribbon regression test'});})()`);
        await wait("!!document.querySelector('.tab-group-indicator')");
        const stack=()=>evaluateHere(`(()=>{
            const group=document.querySelector('.tab-group-indicator'),r=group.getBoundingClientRect(),t=group.previousElementSibling.getBoundingClientRect();
            const indicator=group.querySelector('.tab-indicator.active'),s=getComputedStyle(indicator),i=indicator.getBoundingClientRect();
            const stripes=[...group.querySelectorAll('.tab-indicator')].map(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {y:r.y+parseFloat(s.borderTopWidth)+parseFloat(s.paddingTop),height:r.height-parseFloat(s.borderTopWidth)-parseFloat(s.borderBottomWidth)-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom)};});
            return {height:r.height,y:r.y,tabY:t.y,tabBottom:t.bottom,contentHeight:i.height-parseFloat(s.borderTopWidth)-parseFloat(s.borderBottomWidth)-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom),stripes};
        })()`);
        for(const state of ['normal','maximized']){
            await evaluateHere(`chrome.windows.update(vivaldiWindowId,{state:'${state}'})`);
            await wait(`document.getElementById('browser').classList.contains('maximized')===${state==='maximized'}`);
            for(const edge of [false,true]){
                await pref('vivaldi.tabs.at_edge',edge);
                for(const side of ['top','bottom','left','right']){
                    await check(`${state} ${side} compact stack, at-edge ${edge}`,async()=>{
                        await pref('vivaldi.tabs.bar.position',side);await wait(`document.getElementById('browser').classList.contains('tabs-${side}')`);await delay(150);
                        const s=await stack();
                        assert.ok(s.height<=12,'Marker container must not stretch across the tab');
                        assert.ok(s.contentHeight>0,'Active marker must retain a visible content area');
                        assert.ok(s.stripes.every(stripe=>stripe.height===s.contentHeight),'Active and inactive stripes must have the same visible thickness');
                        assert.ok(s.stripes.every(stripe=>stripe.y===s.stripes[0].y),'Active and inactive stripes must line up');
                        if(side==='bottom')assert.ok(s.y>s.tabY+15,'Bottom markers must stay near the bottom of the tab');
                        else assert.ok(s.y<=s.tabY,'Other markers must stay at the top of the tab');
                    });
                }
            }
        }
        await pref('vivaldi.tabs.bar.position','top');
        await pref('vivaldi.tabs.at_edge',false);
        await pref('vivaldi.appearance.density',false);
        await check('regular density keeps stack stripes thin and aligned',async()=>{await delay(300);const s=await stack();assert.ok(s.height<=12&&s.contentHeight>0);assert.ok(s.stripes.every(stripe=>stripe.height===s.contentHeight&&stripe.y===s.stripes[0].y));});
        // Check the panel remains usable after changing density and tab position.
        await check('native panel still opens with Ribbon',async()=>{
            await pref('vivaldi.panels.as_overlay.enabled',true);
            const p=await evaluateHere("(()=>{const r=document.querySelector('#switch button[data-name=\"PanelBookmarks\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
            for(const type of ['mouseMoved','mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...p,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})},sessionId);
            await wait("!document.getElementById('panels-container').classList.contains('icons')");await delay(650);
            assert.ok(await evaluateHere("document.querySelector('.panel-group').getBoundingClientRect().width>250"));
            await checkColors();
        });

        await check('native page accents follow tab clicks and return to their previous color',async()=>{
            await evaluateHere("(async()=>{const tabs=await chrome.tabs.query({windowId:vivaldiWindowId});const ids=tabs.filter(t=>t.url?.startsWith('about:blank#ribbon-')).map(t=>t.id);if(ids.length)await chrome.tabs.remove(ids);})()");
            await wait("!document.querySelector('.tab-group-indicator')");
            const http=require('node:http');
            const server=http.createServer((req,res)=>{const green=req.url.includes('green');res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="theme-color" content="${green?'#379647':'#212121'}"><title>${green?'Green':'Dark'}</title><body>Local native accent test</body>`);});
            await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
            const port=server.address().port,tabs={};
            try {
                for(const [name,host] of [['green','127.0.0.1'],['dark','localhost']]){
                    tabs[name]=await evaluateHere(`chrome.tabs.create({windowId:vivaldiWindowId,url:'http://${host}:${port}/${name}',active:true})`);
                    await wait(`document.querySelector('.webpageview.active.visible webview')?.src==='http://${host}:${port}/${name}'`);
                    await delay(800);
                }
                let firstGreen;
                for(const name of ['green','dark','green']){
                    // Native UI clicks also update Vivaldi's page accent; tabs.update alone does not.
                    const p=await evaluateHere(`(()=>{const r=document.getElementById('tab-${tabs[name].id}-favicon').closest('.tab').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
                    for(const type of ['mouseMoved','mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...p,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})},sessionId);
                    await delay(650);
                    const bg=await evaluateHere(`(()=>{const s=getComputedStyle(document.querySelector('.tab.active'));const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=s.backgroundColor;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];})()`);
                    if(name==='green'){assert.ok(bg[1]>bg[0]+20&&bg[1]>bg[2]+20,'Green page accent must remain green');if(firstGreen)assert.deepEqual(bg,firstGreen,'Returning to a tab must restore its background');firstGreen=bg;}
                    else assert.ok(Math.max(...bg.slice(0,3))-Math.min(...bg.slice(0,3))<3,'Dark page accent must remain neutral');
                    await checkColors();
                }
            } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        });
        console.log(`${passed} native Vivaldi Ribbon regression cases passed.`);
    } finally {
        ws?.close();child.kill('SIGTERM');
        await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2500);child.once('exit',()=>{clearTimeout(timer);resolve();});});
        fs.rmSync(profile,{recursive:true,force:true});
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
