const grpc = require('grpc')
const protoLoader = require('@grpc/proto-loader')
const btoa = require('btoa')
const atob = require('atob')
const njs = require('numjs')
const crypto = require('crypto')
const utils = require('../../utils')

var PROTO_PATH = __dirname + '/../../proto/faiss.proto'
var packageDefinition = protoLoader.loadSync(
    PROTO_PATH,
    {keepCase: true,
     longs: String,
     enums: String,
     defaults: true,
     oneofs: true
    })

const proto = grpc.loadPackageDefinition(packageDefinition)

var faissRPC = new proto.faiss.FaissService('localhost:50052',
                grpc.credentials.createInsecure())

// temporarily keep vectors in memory until next faiss write
var faissTempVecStore = []

function proto_matrix_transform (matrix_in) {
    var ret = []

    for (let r=0; r<matrix_in.length; r++) {
        var raw = matrix_in[r]
        ret.push({e: raw})
    }
    return ret
}

function initFaiss(nlist, nprobe, bpv, bpsv, vd, cbk) {
    var db = __g__PDBs.documentsDB
    utils.bulkGetVectors(db, (err, train_matrix) => {
        console.log(train_matrix.length, ' documents retrieved for faiss index training')
        if(!err) {
            var faiss_init_data = {
                "nlist": nlist,
                "nprobe": nprobe,
                "bpv": bpv,
                "bpsv": bpsv,
                "vd": vd,
                "matrix": proto_matrix_transform (train_matrix)
            }
            faissRPC.initFaiss(faiss_init_data, cbk)
        }
        else {
            cbk (err, null)
        }
    })
}

function addToFaiss_(matrix_in, cbk) {
    var err_ = false
    var counter = 0
    for (let i=0;i<matrix_in.length;i++) {
        var vector_in = matrix_in[i].m
        var faiss_add_data = {
            documents: [{
                _id: matrix_in[i].i,
                vector: {
                    e: vector_in
                }
            }]
        }
        faissRPC.addVectors(faiss_add_data, (err, resp) => {
            counter ++
            if (err) {
                err_ = err
            }
            if (counter === matrix_in.length) {
                cbk(err_, null)
            }
        })
    }
}

function mapVecDocId (doc_id, vec_id, cbk) {
    // get & increment document count locally in DB
    var mdb = __g__PDBs.mapperDB
    utils.mapDoc2VecID(mdb, doc_id, vec_id, (err) => {
        if (!err) {
            utils.mapVec2DocID(mdb, doc_id, vec_id, (err) => {
                if (!err) {
                    // success mapping done
                    cbk (null)
                }
                else {
                    // failed mapping
                    cbk (err)
                }
            })
        }
        else {
            cbk (err)
        }
    })
}

function getVecId (cbk) {
    // get & increment document count locally in DB
    utils.getVecID((err, counter_) => {
        if (!err) {
            cbk (null, counter_)
        }
        else {
            console.log(err)
            cbk(err, null)
        }
    })
}

var faissIndexBuilt = false
var faissIndexBuildProgress = false

// get faiss status already
var sdb = __g__PDBs.sessionDB
sdb.get('local_faissStatus', (err, doc) => {
    if (doc) {
        faissIndexBuilt = doc.index_trained
    }
})

function addToFaiss(new_matrix, vec_id, cbk) {
    var init_config = __g__vDBConfig.faiss.init
    // faiss index is not built yet
    if (!faissIndexBuilt && !faissIndexBuildProgress) {
        faissIndexBuildProgress = true
        // keep data for addition to faiss
        faissTempVecStore.push({m: new_matrix, i: vec_id})
        // train index only once and update db session
        initFaiss(init_config.nlist, init_config.nprobe, init_config.bpv, init_config.bpsv, init_config.vd, (err, resp) => {
            // update local status about faiss initialization
            sdb.put({_id:'local_faissStatus', index_trained: true}, (err, resp) => {
                if (!err) {
                    faissIndexBuildProgress = false
                    faissIndexBuilt = true

                    // add pending data to faiss
                    var tmp_arr = faissTempVecStore
                    faissTempVecStore = []

                    addToFaiss_(tmp_arr, (err, resp) => {
                        if (!err) {
                            console.log("added to faiss")
                        }
                        else {
                            console.log("can't add vector to faiss", err)
                        }
                    })
                }
            })
        })
    }
    // faiss indexing is in progress
    if (!faissIndexBuilt && faissIndexBuildProgress) {
        faissTempVecStore.push({m: new_matrix, i: vec_id})
    }
    // faiss index is built. We are ready to add new docs
    if (faissIndexBuilt && !faissIndexBuildProgress) {
        faissTempVecStore.push({m: new_matrix, i: vec_id})

        // add pending data to faiss
        var tmp_arr = faissTempVecStore
        faissTempVecStore = []

        addToFaiss_(tmp_arr, (err, resp) => {
            if (!err) {
                console.log("added to faiss")
            }
            else {
                console.log("can't add vector to faiss", err)
            }
        })
    }
}

module.exports = {
    // add a new vector to faiss db
    addNewVector (r_times, doc_id, new_matrix) {
        // check if the document is fresh or not (new doc id)
        if (r_times !== '1') {
            // not fresh
            console.log('Document with id: ' + doc_id + ' is not fresh!')
        }
        else {
            // only add to faiss if document is fresh
            getVecId((err, vec_id) => {
                if (!err) {
                    mapVecDocId (doc_id, vec_id, (err) => {
                        if(!err) {
                            var init_config = __g__vDBConfig.faiss.init

                            // keep vector to be added in memory
                            faissTempVecStore.push({m: new_matrix, i: vec_id})
                            
                            // check if vector count reached trainable min. requirement
                            if (vec_id >= init_config.vecount) {
                                addToFaiss(new_matrix, vec_id, (err, resp) => {
                                    if (!err) {
                                        console.log('Added vectors')
                                    }
                                    else {
                                        console.log('Error adding vectors', err, resp)
                                    } 
                                })    
                            }
                            else {
                                // console.log('Atleast 10000 training data is needed.')
                            }
                        }
                    })
                }
                else {
                    console.log("Can't get vec ID")
                }
            })  
        }  
    },
    getKNN(k, matrix, cbk){
        var faiss_search_data = {
            "matrix": matrix,
            "k": k
        }
        
        faissRPC.getNearest(faiss_search_data, (err, resp) => {
            var db = __g__PDBs.documentsDB
            var mdb = __g__PDBs.mapperDB

            if (!err) {
                var dist_matrix_str = resp.dist_matrix
                var vec_ids = JSON.parse(resp.ids)
                var vec_ids_ = []
                
                // create ids list
                for(let i=0;i<vec_ids.length;i++){
                    for(let j=0;j<vec_ids[i].length;j++){
                        vec_ids_.push(''+vec_ids[i][j])
                    }
                }

                // get real doc ids from mapping
                mdb.allDocs({
                    include_docs: true,
                    keys: vec_ids_
                }, function(err, resp) {
                    if(!err) {
                        var doc_ids_ = []
                        for(let i=0;i<resp.rows.length;i++){
                            doc_ids_.push(resp.rows[i].doc.val)
                        }

                        // get real docs
                        db.allDocs({
                            include_docs: true,
                            keys: doc_ids_
                        }, function(err, resp) {
                            if(!err) {
                                resp_ = {
                                    status: true,
                                    dist_matrix: dist_matrix_str,
                                    documents: btoa(JSON.stringify(resp.rows))
                                }
                                cbk(err, resp_)
                            }
                            else{
                                cbk(err, resp)
                            }
                        })
                    }
                    else{
                        cbk(err, resp)
                    }
                })
            }
            else {
                cbk (err, null)
            }
        })
    }
}