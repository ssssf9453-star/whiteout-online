/* STILLSHOT: WHITEOUT — CrazyGames SDK v3 persistent save adapter.
 * Source: https://docs.crazygames.com/sdk/intro/ and /sdk/data/
 * Only the game progression is synced. Room tokens/ranked identity remain outside
 * client-side cloud storage, because they are not trustworthy account credentials.
 */
(()=>{'use strict';
  const GAME_KEY='whiteout_save_v1';
  const MIGRATED='whiteout_cloud_migration_v1';
  const sdkURL='https://sdk.crazygames.com/crazygames-sdk-v3.js';
  const host=location.hostname.toLowerCase();
  const likelyCrazy=/(^|\.)crazygames\.com$/.test(host)||/(^|\.)crazygamescdn\.com$/.test(host)||
    /(^|\.)crazygames\.com(?=\/|$)/i.test((document.referrer||'').replace(/^https?:\/\//i,''))||
    host==='localhost'||host==='127.0.0.1'||new URLSearchParams(location.search).has('useLocalSdk');
  const realCrazy=/(^|\.)crazygames\.com$/.test(host)||/(^|\.)crazygamescdn\.com$/.test(host)||
    /(^|\.)crazygames\.com(?=\/|$)/i.test((document.referrer||'').replace(/^https?:\/\//i,''));
  const adapter={mode:'initializing',environment:'',error:null,user:null,ready:null,
    getGame(){
      if(this.mode==='cloud')return window.CrazyGames.SDK.data.getItem(GAME_KEY);
      if(this.mode==='local')return localStorage.getItem(GAME_KEY);
      return null; // never read stale account-local data when cloud init failed
    },
    setGame(value){
      if(typeof value!=='string')throw new TypeError('Game save must be serialized JSON');
      try{
        if(this.mode==='cloud')window.CrazyGames.SDK.data.setItem(GAME_KEY,value);
        else if(this.mode==='local')localStorage.setItem(GAME_KEY,value);
        else throw new Error('Cloud saving is unavailable. Progress was not saved.');
        this.error=null;this.updateIndicators();return true;
      }catch(err){this.error=err;this.updateIndicators();console.error('[WHITEOUT SAVE] Write failed:',err);return false;}
    },
    status(){
      if(this.error)return 'SAVE ERROR · NOT SAVED';
      if(this.mode==='cloud')return this.environment==='local'?'SDK TEST · LOCAL ONLY':(this.user?'CLOUD SAVE · ACCOUNT':'GUEST SAVE · LOCAL');
      if(this.mode==='local')return 'LOCAL SAVE · THIS BROWSER';
      if(this.mode==='initializing')return 'LOADING SAVE…';
      return 'SAVE OFFLINE · NOT SAVED';
    },
    updateIndicators(){for(const el of document.querySelectorAll('[data-whiteout-save-status]')){
      el.textContent=this.status();el.title=this.mode==='cloud'?'CrazyGames Data Module: syncs when signed in.':this.mode==='local'?'Saved on this browser only.':'Cloud data unavailable. Do not assume progress is backed up.';
    }}
  };
  window.WHITEOUT_SAVE=adapter;
  async function loadSdk(){
    if(window.CrazyGames?.SDK?.init)return;
    await new Promise((resolve,reject)=>{
      const s=document.createElement('script');s.src=sdkURL;s.async=true;
      const timer=setTimeout(()=>{s.remove();reject(new Error('CrazyGames SDK load timeout'));},8000);
      s.onload=()=>{clearTimeout(timer);resolve();};
      s.onerror=()=>{clearTimeout(timer);reject(new Error('CrazyGames SDK failed to load'));};
      document.head.appendChild(s);
    });
  }
  adapter.ready=(async()=>{
    if(!likelyCrazy){adapter.mode='local';return adapter;}
    try{
      await loadSdk();
      const sdk=window.CrazyGames?.SDK;
      if(!sdk?.init)throw new Error('SDK unavailable');
      // The SDK can occasionally stall in an iframe. Never block the game forever:
      // give initialization a bounded wait, then show an explicit save-unavailable
      // state inside CrazyGames without silently overwriting cloud progress.
      let initTimer;
      try {
        await Promise.race([
          Promise.resolve().then(()=>sdk.init()),
          new Promise((_,reject)=>{initTimer=setTimeout(()=>reject(new Error('CrazyGames SDK initialization timeout')),6500);})
        ]);
      } finally {clearTimeout(initTimer);}
      adapter.environment=sdk.environment||'';
      if(sdk.environment==='disabled'){adapter.mode='local';return adapter;}
      // First try to read cloud progress. On any SDK error, DO NOT overwrite
      // it with defaults or old browser values.
      const current=sdk.data.getItem(GAME_KEY);
      if(current==null){
        const migrated=localStorage.getItem(MIGRATED);
        const previous=localStorage.getItem(GAME_KEY);
        if(!migrated&&previous){
          try{JSON.parse(previous);sdk.data.setItem(GAME_KEY,previous);}
          catch(e){console.warn('[WHITEOUT SAVE] Skipped invalid legacy save:',e);}
        }
      }
      try{localStorage.setItem(MIGRATED,'1');}catch(_){}
      adapter.mode='cloud';
      // User lookup is non-blocking so a slow account endpoint cannot delay gameplay.
      if(sdk.user?.getUser)Promise.resolve().then(()=>sdk.user.getUser()).then(user=>{adapter.user=user||null;adapter.updateIndicators();}).catch(()=>{});
      return adapter;
    }catch(err){
      adapter.mode=realCrazy?'unavailable':'local';
      adapter.error=realCrazy?err:null;
      console.warn('[WHITEOUT SAVE] CrazyGames SDK unavailable:',err);
      return adapter;
    }finally{adapter.updateIndicators();}
  })();
})();
