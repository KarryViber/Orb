const t=a=>{if(!a||typeof a!="object")throw new Error("Invalid API response");return{data:a.data||[],total:a.total||0,page:a.page||1,pageSize:a.pageSize||10}};export{t as h};
