export async function runBatch(items, operation, { signal, onProgress } = {}) {
  const results=[];let completed=0;
  for(const item of items){if(signal?.aborted){results.push({item,status:"cancelled"});continue;}try{const value=await operation(item);results.push({item,status:value?.skipped?"skipped":"success",value});}catch(error){results.push({item,status:"failed",error});}completed++;onProgress?.({current:completed,total:items.length,item, result:results.at(-1)});}
  return {results,success:results.filter(item=>item.status==="success"),skipped:results.filter(item=>item.status==="skipped"),failed:results.filter(item=>item.status==="failed"),cancelled:results.filter(item=>item.status==="cancelled")};
}
export async function applyProjectMembership(items, { projectId, remove=false, getProject, addResource, removeResource, typeFor, onProgress } = {}) {
  if(!projectId)throw new TypeError("A project ID is required.");
  const project=await getProject(projectId),operations=[];
  const result=await runBatch(items,async item=>{
    const type=typeFor(item),present=Boolean(project?.resources?.[type]?.includes(item.id)),desired=!remove;
    if(present===desired)return {skipped:true};
    if(remove)await removeResource(projectId,type,item.id);else await addResource(projectId,type,item.id);
    const operation={type,id:item.id,before:present,after:desired};operations.push(operation);return operation;
  },{onProgress});
  return {...result,operations};
}
