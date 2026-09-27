use ezpz::{
    Config, Constraint, ConstraintRequest, Id, IdGenerator, SolveOutcome,
    datatypes::inputs::DatumPoint, solve, solve_analysis,
};
use serde::Serialize;
use std::time::Instant;

#[derive(Clone, Copy)]
struct DistDef {
    a: DatumPoint,
    b: DatumPoint,
    target: f64,
}

struct Problem {
    points: Vec<DatumPoint>,
    dists: Vec<DistDef>,
    guesses: Vec<(Id, f64)>,
}

#[derive(Serialize)]
struct Row {
    requested_distance_constraints: usize,
    variables: usize,
    total_constraints: usize,
    cold_median_ms: f64,
    warm_public_api_rebuild_median_ms: f64,
    structural_edit_ms: f64,
    warm_iterations: usize,
    satisfied: bool,
    converged: bool,
}

#[derive(Serialize)]
struct Diagnostics {
    underconstrained_detected: bool,
    overconstrained_detected: bool,
}

#[derive(Serialize)]
struct Report {
    candidate: &'static str,
    source_commit: &'static str,
    benchmark_semantics: &'static str,
    rows: Vec<Row>,
    diagnostics: Diagnostics,
}

fn target_xy(i: usize) -> (f64, f64) {
    if i == 0 { return (0.0, 0.0); }
    if i == 1 { return (4.0, 0.0); }
    (i as f64 * 4.0, if i % 2 == 0 { 3.0 } else { -3.0 })
}

fn distance(a: (f64,f64), b: (f64,f64)) -> f64 {
    let dx=a.0-b.0; let dy=a.1-b.1;
    (dx*dx+dy*dy).sqrt()
}

fn build(distance_constraints: usize) -> Problem {
    let n = distance_constraints.div_ceil(2) + 2;
    let mut ids = IdGenerator::default();
    let mut points = Vec::with_capacity(n);
    let mut guesses = Vec::with_capacity(n*2);

    for i in 0..n {
        let p = DatumPoint::new(&mut ids);
        let (x,y)=target_xy(i);
        let perturb = if i < 2 { 0.0 } else { if i%2==0 {0.35} else {-0.27} };
        guesses.push((p.id_x(), x + perturb));
        guesses.push((p.id_y(), y - perturb*0.5));
        points.push(p);
    }

    let mut dists=Vec::new();
    for i in 2..n {
        if dists.len() < distance_constraints {
            dists.push(DistDef{
                a:points[i], b:points[i-1],
                target:distance(target_xy(i),target_xy(i-1))
            });
        }
        if dists.len() < distance_constraints {
            dists.push(DistDef{
                a:points[i], b:points[i-2],
                target:distance(target_xy(i),target_xy(i-2))
            });
        }
    }
    Problem{points,dists,guesses}
}

fn requests(problem:&Problem) -> Vec<ConstraintRequest> {
    let mut reqs=Vec::with_capacity(problem.dists.len()+4);
    let p0=problem.points[0]; let p1=problem.points[1];
    let (x0,y0)=target_xy(0); let (x1,y1)=target_xy(1);
    reqs.push(ConstraintRequest::highest_priority(Constraint::Fixed(p0.id_x(),x0)));
    reqs.push(ConstraintRequest::highest_priority(Constraint::Fixed(p0.id_y(),y0)));
    reqs.push(ConstraintRequest::highest_priority(Constraint::Fixed(p1.id_x(),x1)));
    reqs.push(ConstraintRequest::highest_priority(Constraint::Fixed(p1.id_y(),y1)));
    for d in &problem.dists {
        reqs.push(ConstraintRequest::highest_priority(Constraint::Distance(d.a,d.b,d.target)));
    }
    reqs
}

fn solved_guesses(out:&SolveOutcome)->Vec<(Id,f64)> {
    out.final_values().iter().enumerate().map(|(i,v)|(i as Id,*v)).collect()
}

fn median(mut xs:Vec<f64>)->f64 {
    xs.sort_by(|a,b|a.total_cmp(b));
    xs[xs.len()/2]
}

fn run_size(k:usize)->Row {
    let cold_reps=if k>=1000 {3}else{5};
    let mut cold=Vec::new();
    let mut last_satisfied=false;
    let mut last_converged=false;
    for _ in 0..cold_reps {
        let p=build(k);
        let reqs=requests(&p);
        let t=Instant::now();
        let out=solve(&reqs,p.guesses.clone(),Config::default()).expect("EZPZ cold solve failed");
        cold.push(t.elapsed().as_secs_f64()*1000.0);
        last_satisfied=out.is_satisfied();
        last_converged=out.converged();
    }

    let mut p=build(k);
    let reqs=requests(&p);
    let first=solve(&reqs,p.guesses.clone(),Config::default()).expect("EZPZ initial warm solve failed");
    let mut guesses=solved_guesses(&first);
    let mid=p.dists.len()/2;
    let base=p.dists[mid].target;
    let warm_n=if k>=1000 {20}else{50};
    let mut warm=Vec::new();
    let mut final_out=first;
    for i in 0..warm_n {
        p.dists[mid].target=base*(if i%2==0 {1.001}else{0.999});
        let reqs=requests(&p);
        let t=Instant::now();
        final_out=solve(&reqs,guesses,Config::default()).expect("EZPZ warm solve failed");
        warm.push(t.elapsed().as_secs_f64()*1000.0);
        guesses=solved_guesses(&final_out);
    }

    let bigger=build(k+2);
    let bigger_reqs=requests(&bigger);
    let t=Instant::now();
    let _=solve(&bigger_reqs,bigger.guesses.clone(),Config::default()).expect("EZPZ structural solve failed");
    let structural=t.elapsed().as_secs_f64()*1000.0;

    Row{
        requested_distance_constraints:k,
        variables:p.points.len()*2,
        total_constraints:p.dists.len()+4,
        cold_median_ms:median(cold),
        warm_public_api_rebuild_median_ms:median(warm),
        structural_edit_ms:structural,
        warm_iterations:warm_n,
        satisfied:final_out.is_satisfied() && last_satisfied,
        converged:final_out.converged() && last_converged,
    }
}

fn diagnostics()->Diagnostics {
    let mut ids=IdGenerator::default();
    let a=DatumPoint::new(&mut ids); let b=DatumPoint::new(&mut ids);
    let under_reqs=vec![
        ConstraintRequest::highest_priority(Constraint::Fixed(a.id_x(),0.0)),
        ConstraintRequest::highest_priority(Constraint::Fixed(a.id_y(),0.0)),
        ConstraintRequest::highest_priority(Constraint::Distance(a,b,4.0)),
    ];
    let guesses=vec![(a.id_x(),0.0),(a.id_y(),0.0),(b.id_x(),4.1),(b.id_y(),0.2)];
    let under=solve_analysis(&under_reqs,guesses,Config::default())
        .map(|x|x.analysis.is_underconstrained()).unwrap_or(false);

    let mut ids=IdGenerator::default();
    let a=DatumPoint::new(&mut ids); let b=DatumPoint::new(&mut ids);
    let over_reqs=vec![
        ConstraintRequest::highest_priority(Constraint::Fixed(a.id_x(),0.0)),
        ConstraintRequest::highest_priority(Constraint::Fixed(a.id_y(),0.0)),
        ConstraintRequest::highest_priority(Constraint::Fixed(b.id_x(),10.0)),
        ConstraintRequest::highest_priority(Constraint::Fixed(b.id_y(),0.0)),
        ConstraintRequest::highest_priority(Constraint::Distance(a,b,4.0)),
    ];
    let guesses=vec![(a.id_x(),0.0),(a.id_y(),0.0),(b.id_x(),10.0),(b.id_y(),0.0)];
    let over=match solve(&over_reqs,guesses,Config::default()) {
        Ok(o)=>o.is_unsatisfied() || !o.converged(),
        Err(_)=>true,
    };
    Diagnostics{underconstrained_detected:under,overconstrained_detected:over}
}

fn main() {
    let rows=[50usize,100,500,2000].into_iter().map(run_size).collect();
    let report=Report{
        candidate:"EZPZ",
        source_commit:"915882cc731da31042ce494c89b10334ee57837a",
        benchmark_semantics:"cold solve; warm repeated solve using solved values but public API rebuilds internal model; structural = larger rebuilt problem",
        rows,
        diagnostics:diagnostics(),
    };
    println!("{}",serde_json::to_string_pretty(&report).unwrap());
}
